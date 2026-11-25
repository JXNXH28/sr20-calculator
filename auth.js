// Supabase auth client without supabase-js: talks to GoTrue and PostgREST with fetch. Needs /api/config.js first.
(function () {
  'use strict';
  var CFG = window.SB_CONFIG || {}, KEY = 'sr20.auth', LOGIN = '/login.html';
  var session = null, timer = null, refreshing = null;

  function store(op, v) {
    try { if (op === 'get') return localStorage.getItem(KEY); if (op === 'set') localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch (e) { /* storage blocked */ }
    return null;
  }
  function setCookie(s) {
    try {
      var secure = location.protocol === 'https:' ? '; Secure' : '';
      if (!s) { document.cookie = 'sb_at=; Path=/; SameSite=Lax; Max-Age=0' + secure; return; }
      var age = Math.max(0, Math.floor(s.expires_at - Date.now() / 1000));
      document.cookie = 'sb_at=' + s.access_token + '; Path=/; SameSite=Lax; Max-Age=' + age + secure;
    } catch (e) { /* ignore */ }
  }
  function schedule() {
    clearTimeout(timer); timer = null;
    if (!session) return;
    var ms = Math.max(1000, (session.expires_at - 60) * 1000 - Date.now());
    timer = setTimeout(function () { refresh().catch(function () {}); }, Math.min(ms, 2147483000));
  }
  function setSession(s, persist) {
    session = s;
    if (persist !== false) { if (s) store('set', JSON.stringify(s)); else store('del'); }
    setCookie(s); schedule();
  }
  function load() {
    try { var raw = store('get'); session = raw ? JSON.parse(raw) : null; } catch (e) { session = null; }
    if (session && (!session.access_token || !session.refresh_token)) session = null;
    setCookie(session); schedule();
  }
  function normalize(j) {
    var exp = j.expires_at || (Math.floor(Date.now() / 1000) + (+j.expires_in || 3600));
    return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: exp, user: { id: (j.user && j.user.id) || userIdOf(j.access_token), email: (j.user && j.user.email) || emailOf(j.access_token) } };
  }
  function claims(t) {
    try { var p = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'); while (p.length % 4) p += '='; return JSON.parse(decodeURIComponent(escape(atob(p)))); } catch (e) { return {}; }
  }
  function userIdOf(t) { return claims(t).sub || null; }
  function emailOf(t) { return claims(t).email || null; }

  function msg(j, status) {
    var m = j && (j.error_description || j.msg || j.message || j.error);
    if (/invalid login credentials/i.test(m || '')) return 'Wrong email or password.';
    if (/email not confirmed/i.test(m || '')) return 'This email address has not been confirmed yet.';
    if (/should be different|same as the old/i.test(m || '')) return 'Choose a password different from the old one.';
    if (/at least \d+ char|weak|password should/i.test(m || '')) return 'That password is too weak. Use at least 8 characters.';
    if (/rate limit|too many/i.test(m || '') || status === 429) return 'Too many attempts. Wait a minute and try again.';
    if (/expired|invalid.*(token|link)|otp/i.test(m || '')) return 'This link has expired or was already used. Ask for a new one.';
    return m || ('Request failed (' + status + ')');
  }
  function netErr(e) { return e && e.status ? e : Object.assign(new Error('Network problem. Check your connection and try again.'), { status: 0 }); }

  function gotrue(path, opts, bearer) {
    var h = { apikey: CFG.anonKey, 'Content-Type': 'application/json' };
    if (bearer) h.Authorization = 'Bearer ' + bearer;
    return fetch(CFG.url + '/auth/v1' + path, { method: (opts && opts.method) || 'POST', headers: h, body: opts && opts.body !== undefined ? JSON.stringify(opts.body) : undefined })
      .catch(function (e) { throw netErr(e); })
      .then(function (r) {
        return r.text().then(function (t) {
          var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { /* not json */ }
          if (!r.ok) throw Object.assign(new Error(msg(j, r.status)), { status: r.status });
          return j;
        });
      });
  }

  function refresh() {
    if (refreshing) return refreshing;
    if (!session) return Promise.reject(new Error('Not signed in'));
    var rt = session.refresh_token;
    refreshing = gotrue('/token?grant_type=refresh_token', { body: { refresh_token: rt } })
      .then(function (j) { setSession(normalize(j)); return session; })
      .catch(function (e) {
        // Another tab may have refreshed already.
        load();
        if (session && session.refresh_token !== rt) return session;
        if (e && e.status === 0) throw e; // offline: keep session, retry later
        setSession(null); throw e;
      })
      .then(function (s) { refreshing = null; return s; }, function (e) { refreshing = null; throw e; });
    return refreshing;
  }

  function token() {
    if (!session) return Promise.reject(new Error('Not signed in'));
    if (session.expires_at - Date.now() / 1000 < 60) return refresh().then(function (s) { return s.access_token; });
    return Promise.resolve(session.access_token);
  }

  function restFetch(path, opts) {
    opts = opts || {};
    return token().then(function (t) {
      var h = Object.assign({ apikey: CFG.anonKey, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, opts.headers || {});
      return fetch(CFG.url + '/rest/v1' + path, Object.assign({}, opts, { headers: h }));
    }).then(function (r) {
      return r.text().then(function (t) {
        var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { /* not json */ }
        if (!r.ok) throw Object.assign(new Error((j && (j.message || j.error_description || j.error)) || ('Request failed (' + r.status + ')')), { status: r.status, code: j && j.code });
        return j;
      });
    }, function (e) { throw e && e.status !== undefined ? e : netErr(e); });
  }

  function fetchProfile(uid) {
    return restFetch('/profiles?select=id,email,name,role,tokens,disabled&id=eq.' + encodeURIComponent(uid), { headers: { Accept: 'application/vnd.pgrst.object+json' } });
  }

  function signIn(email, password) {
    return gotrue('/token?grant_type=password', { body: { email: String(email).trim(), password: password } })
      .then(function (j) { setSession(normalize(j)); return session; });
  }
  function signOut() {
    var t = session && session.access_token;
    var done = function () { setSession(null); location.replace(LOGIN); return new Promise(function () {}); };
    if (!t) return done();
    return gotrue('/logout', {}, t).then(done, done);
  }
  function sendReset(email) {
    return gotrue('/recover?redirect_to=' + encodeURIComponent(location.origin + '/login.html'), { body: { email: String(email).trim() } }).then(function () { return true; });
  }
  function setPassword(password, name) {
    var body = { password: password };
    if (name) body.data = { name: name };
    return token().then(function (t) { return gotrue('/user', { method: 'PUT', body: body }, t); })
      .then(function (u) { if (session && u && u.email) { session.user = { id: u.id || session.user.id, email: u.email }; setSession(session); } return true; });
  }

  function consumeUrl() {
    var hash = location.hash.replace(/^#/, ''), search = new URLSearchParams(location.search);
    var hp = new URLSearchParams(hash), type;
    function strip(keys) {
      keys.forEach(function (k) { search.delete(k); });
      var q = search.toString();
      history.replaceState(null, '', location.pathname + (q ? '?' + q : ''));
    }
    if (hp.get('error') || hp.get('error_description')) {
      var d = hp.get('error_description') || hp.get('error');
      history.replaceState(null, '', location.pathname + location.search);
      throw new Error(/expired|invalid/i.test(d) ? 'This link has expired or was already used. Ask for a new one.' : d.replace(/\+/g, ' '));
    }
    if (hp.get('access_token') && hp.get('refresh_token')) {
      type = hp.get('type');
      if (type !== 'invite' && type !== 'recovery') return Promise.resolve(null);
      setSession(normalize({ access_token: hp.get('access_token'), refresh_token: hp.get('refresh_token'), expires_in: hp.get('expires_in') }));
      history.replaceState(null, '', location.pathname + location.search);
      return Promise.resolve(type);
    }
    var th = search.get('token_hash');
    type = search.get('type');
    if (th && (type === 'invite' || type === 'recovery')) {
      return gotrue('/verify', { body: { type: type, token_hash: th } }).then(function (j) {
        setSession(normalize(j)); strip(['token_hash', 'type']); return type;
      }, function (e) { strip(['token_hash', 'type']); throw e; });
    }
    return Promise.resolve(null);
  }

  function never() { return new Promise(function () {}); }
  function requireUser() {
    if (!session) { location.replace(LOGIN + '?next=' + encodeURIComponent(location.pathname + location.search)); return never(); }
    return token().then(function () { return fetchProfile(session.user.id); }).then(function (p) {
      if (p.disabled) { return signOutTo(LOGIN + '?disabled=1'); }
      return { user: session.user, profile: p };
    }, function (e) {
      if (!session || e.status === 401) { location.replace(LOGIN + '?next=' + encodeURIComponent(location.pathname + location.search)); return never(); }
      throw e;
    });
  }
  function signOutTo(url) {
    var t = session && session.access_token;
    var done = function () { setSession(null); location.replace(url); return never(); };
    return t ? gotrue('/logout', {}, t).then(done, done) : done();
  }
  function requireAdmin() {
    return requireUser().then(function (r) { if (r.profile.role !== 'admin') { location.replace('/'); return never(); } return r; });
  }
  function profile() { if (!session) return Promise.reject(new Error('Not signed in')); return fetchProfile(session.user.id); }

  window.addEventListener('storage', function (e) { if (e.key === KEY || e.key === null) { load(); } });
  load();

  window.Auth = {
    signIn: signIn, signOut: signOut, sendReset: sendReset, setPassword: setPassword, consumeUrl: consumeUrl,
    token: token, rest: restFetch, rpc: function (fn, args) { return restFetch('/rpc/' + fn, { method: 'POST', body: JSON.stringify(args || {}) }); },
    requireUser: requireUser, requireAdmin: requireAdmin, profile: profile,
    session: function () { return session; }, hasSession: function () { return !!session; }
  };
})();
