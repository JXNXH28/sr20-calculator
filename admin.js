// Admin console: usage per user, token/role/disable actions, details, calculation log, invites.
// All server strings go through textContent (see h()); there is no innerHTML anywhere.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var users = [], sortKey = 'calcs_period', sortDir = -1, openUser = null, period = null;

  // ---- helpers
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'text') e.textContent = attrs[k]; else if (k === 'class') e.className = attrs[k];
      else if (k.slice(0, 2) === 'on') e[k] = attrs[k]; else if (attrs[k] !== false && attrs[k] != null) e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c != null) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function clear(e) { while (e.firstChild) e.removeChild(e.firstChild); return e; }
  function td(v, cls) { return h('td', { text: v == null ? '' : String(v), class: cls || '' }); }
  function fmtDT(s) {
    if (!s) return '—';
    var d = new Date(s); if (isNaN(d)) return '';
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function fmtD(s) { var d = s ? new Date(s) : null; return d && !isNaN(d) ? fmtDT(s).slice(0, 10) : '—'; }
  var ERR = {
    insufficient_tokens: 'Not enough tokens: the balance cannot go below zero.',
    forbidden: 'You are not allowed to do that.',
    invalid_role: 'Invalid role.',
    already_registered: 'That email address is already registered.',
    invalid_email: 'Enter a valid email address.', invalid_name: 'Name is too long (max 100 characters).',
    invalid_tokens: 'Tokens must be a whole number from 0 to 1000.', unauthenticated: 'Session expired. Sign in again.'
  };
  function errMsg(e) { var m = e && e.message || 'Something went wrong.'; return ERR[m] || m; }
  function say(text, kind) { var s = $('status'); s.textContent = text || ''; s.hidden = !text; s.className = kind || ''; }
  function fail(e) {
    if (e && e.message === 'forbidden' && !(e.apiDetail)) { location.replace('/'); return; }
    say(errMsg(e), 'err');
  }
  function dayStart(v) { var p = v.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function nextDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1); }
  function nameOf(u) { return (u && (u.name || u.email)) || ''; }

  // ---- period
  function computePeriod() {
    var v = $('period').value, now = new Date(), from, to;
    if (v === 'week') { var dow = (now.getDay() + 6) % 7; from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow); to = nextDay(now); }
    else if (v === 'month') { from = new Date(now.getFullYear(), now.getMonth(), 1); to = nextDay(now); }
    else if (v === '30d') { from = new Date(now.getTime() - 30 * 864e5); to = new Date(now.getTime() + 60e3); }
    else {
      if (!$('pFrom').value || !$('pTo').value) throw new Error('Pick both dates.');
      from = dayStart($('pFrom').value); to = nextDay(dayStart($('pTo').value));
      if (to <= from) throw new Error('The end date must not be before the start date.');
    }
    return { from: from, to: to };
  }

  // ---- usage table
  var COLS = [
    ['name', 'Name'], ['email', 'Email'], ['role', 'Role'], ['status', 'Status'], ['tokens', 'Tokens left', 1],
    ['calcs_period', 'Calcs in period', 1], ['calcs_week', 'Calcs 7 d', 1], ['calcs_month', 'Calcs 30 d', 1], ['calcs_total', 'Total', 1],
    ['granted_total', 'Tokens granted', 1], ['last_calc', 'Last calculation'], ['created_at', 'Joined'], ['_a', 'Actions']
  ];
  function sortVal(u, k) {
    if (k === 'status') return u.disabled ? 'disabled' : 'active';
    var v = u[k]; if (v == null) return typeof u[k] === 'number' ? 0 : '';
    return typeof v === 'string' ? v.toLowerCase() : v;
  }
  function renderUsage() {
    var t = clear($('usageTbl')), list = users.slice();
    list.sort(function (a, b) { var x = sortVal(a, sortKey), y = sortVal(b, sortKey); return (x < y ? -1 : x > y ? 1 : 0) * sortDir; });
    var tr = h('tr');
    COLS.forEach(function (c) {
      var th = h('th', { text: c[1] + (sortKey === c[0] ? (sortDir > 0 ? ' ▲' : ' ▼') : ''), class: (c[2] ? 'n ' : '') + (c[0] === '_a' ? '' : 's') });
      if (c[0] !== '_a') th.onclick = function () { if (sortKey === c[0]) sortDir = -sortDir; else { sortKey = c[0]; sortDir = c[2] || c[0] === 'last_calc' || c[0] === 'created_at' ? -1 : 1; } renderUsage(); };
      tr.appendChild(th);
    });
    t.appendChild(h('thead', null, [tr]));
    var max = 0, sums = { tokens: 0, calcs_period: 0, calcs_week: 0, calcs_month: 0, calcs_total: 0, granted_total: 0 };
    users.forEach(function (u) { max = Math.max(max, u.calcs_period || 0); Object.keys(sums).forEach(function (k) { sums[k] += +u[k] || 0; }); });
    var body = h('tbody');
    list.forEach(function (u) {
      var r = h('tr', { class: u.disabled ? 'off' : '' });
      r.appendChild(td(u.name)); r.appendChild(td(u.email)); r.appendChild(td(u.role)); r.appendChild(td(u.disabled ? 'Disabled' : 'Active'));
      r.appendChild(td(u.tokens, 'n'));
      var cp = h('td', { class: 'n' }, [String(u.calcs_period || 0), h('span', { class: 'bar', style: 'width:' + (max ? Math.round((u.calcs_period || 0) / max * 60) : 0) + 'px' })]);
      r.appendChild(cp);
      r.appendChild(td(u.calcs_week, 'n')); r.appendChild(td(u.calcs_month, 'n')); r.appendChild(td(u.calcs_total, 'n')); r.appendChild(td(u.granted_total, 'n'));
      r.appendChild(td(fmtDT(u.last_calc))); r.appendChild(td(fmtD(u.created_at)));
      r.appendChild(h('td', null, [actions(u)]));
      body.appendChild(r);
      if (u._adj) body.appendChild(h('tr', null, [h('td', { colspan: COLS.length }, [adjForm(u)])]));
    });
    t.appendChild(body);
    var f = h('tr');
    COLS.forEach(function (c, i) { f.appendChild(h('td', { class: c[2] ? 'n' : '', text: i === 0 ? 'Total (' + users.length + ' users)' : (sums[c[0]] != null && c[2] ? String(sums[c[0]]) : '') })); });
    t.appendChild(h('tfoot', null, [f]));
  }
  function actions(u) {
    var me = (Auth.session() || {}).user || {};
    var self = u.user_id === me.id;
    return h('div', { class: 'acts' }, [
      h('button', { type: 'button', class: 'sm', text: '+ / − tokens', onclick: function () { u._adj = !u._adj; renderUsage(); } }),
      h('button', { type: 'button', class: 'sm', text: u.disabled ? 'Enable' : 'Disable', disabled: self ? 'disabled' : false, onclick: function () { setUser(u, { disabled: !u.disabled }); } }),
      h('button', { type: 'button', class: 'sm', text: u.role === 'admin' ? 'Remove admin' : 'Make admin', disabled: self ? 'disabled' : false, onclick: function () { setUser(u, { role: u.role === 'admin' ? 'user' : 'admin' }); } }),
      h('button', { type: 'button', class: 'sm', text: 'Details', onclick: function () { showDetails(u); } })
    ]);
  }
  function adjForm(u) {
    var amt = h('input', { type: 'number', min: '1', step: '1', placeholder: 'Amount', required: 'required', 'aria-label': 'Amount' });
    var note = h('input', { type: 'text', class: 'note', maxlength: '200', placeholder: 'Note (optional)', 'aria-label': 'Note' });
    var go = function (sign) {
      var n = parseInt(amt.value, 10);
      if (!(n >= 1) || n > 100000) return say('Enter a whole amount of at least 1.', 'err');
      say('');
      Auth.rpc('admin_adjust_tokens', { p_user: u.user_id, p_delta: sign * n, p_note: note.value.trim() || null }).then(function (bal) {
        u.tokens = typeof bal === 'number' ? bal : u.tokens + sign * n;
        if (sign > 0) u.granted_total = (u.granted_total || 0) + n;
        u._adj = false; renderUsage();
        say(nameOf(u) + ': new balance ' + u.tokens + ' token' + (u.tokens === 1 ? '' : 's') + '.', 'ok');
        if (openUser && openUser.user_id === u.user_id) showDetails(u);
      }, fail);
    };
    return h('div', { class: 'adj' }, [h('span', { text: nameOf(u) + ':' }), amt, note,
      h('button', { type: 'button', class: 'sm pri', text: '+ Add', onclick: function () { go(1); } }),
      h('button', { type: 'button', class: 'sm', text: '− Remove', onclick: function () { go(-1); } }),
      h('button', { type: 'button', class: 'sm', text: 'Cancel', onclick: function () { u._adj = false; renderUsage(); } })]);
  }
  function setUser(u, ch) {
    var q = ch.disabled !== undefined ? (ch.disabled ? 'Disable ' : 'Enable ') + nameOf(u) + '?' + (ch.disabled ? ' They will be signed out of the calculator.' : '')
      : (ch.role === 'admin' ? 'Make ' + nameOf(u) + ' an admin?' : 'Remove admin rights from ' + nameOf(u) + '?');
    if (!confirm(q)) return;
    say('');
    Auth.rpc('admin_set_user', { p_user: u.user_id, p_disabled: ch.disabled === undefined ? null : ch.disabled, p_role: ch.role || null }).then(function () {
      if (ch.disabled !== undefined) u.disabled = ch.disabled;
      if (ch.role) u.role = ch.role;
      renderUsage(); say('Updated ' + nameOf(u) + '.', 'ok');
    }, fail);
  }

  function loadUsage() {
    try { period = computePeriod(); } catch (e) { return say(e.message, 'err'); }
    say('Loading…');
    $('periodLabel').textContent = 'Period: ' + fmtDT(period.from).slice(0, 10) + ' to ' + fmtDT(new Date(period.to.getTime() - 1)).slice(0, 10);
    return Auth.rpc('admin_usage', { p_from: period.from.toISOString(), p_to: period.to.toISOString() }).then(function (rows) {
      users = rows || []; say(''); renderUsage(); fillUserSelect();
    }, fail);
  }

  // ---- inputs snapshot
  function inputsTable(inputs) {
    var groups = {}, order = [];
    var flat = {};
    function add(prefix, v) {
      if (v && typeof v === 'object' && !Array.isArray(v) && prefix.split('.').length < 3) Object.keys(v).forEach(function (k) { add(prefix ? prefix + '.' + k : k, v[k]); });
      else flat[prefix] = v;
    }
    add('', inputs && typeof inputs === 'object' ? inputs : { value: inputs });
    Object.keys(flat).forEach(function (k) {
      var i = k.indexOf('.'), g = i < 0 ? 'General' : k.slice(0, i), name = i < 0 ? k : k.slice(i + 1);
      if (!groups[g]) { groups[g] = []; order.push(g); }
      var v = flat[k]; groups[g].push([name, v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v)]);
    });
    order.sort(function (a, b) { return a === 'General' ? -1 : b === 'General' ? 1 : a < b ? -1 : a > b ? 1 : 0; });
    var tb = h('tbody');
    order.forEach(function (g) {
      tb.appendChild(h('tr', null, [h('td', { class: 'grp', colspan: '2', text: g })]));
      groups[g].forEach(function (kv) { tb.appendChild(h('tr', null, [h('th', { text: kv[0] }), td(kv[1])])); });
    });
    return h('div', { class: 'wrap' }, [h('table', { class: 'kv' }, [tb])]);
  }
  function viewInputs(id, host) {
    clear(host); host.hidden = false; host.appendChild(h('p', { class: 'muted', text: 'Loading inputs…' }));
    Auth.rest('/calculations?id=eq.' + encodeURIComponent(id) + '&select=inputs').then(function (rows) {
      clear(host);
      host.appendChild(h('h2', { text: 'Inputs of calculation #' + id }));
      host.appendChild(rows && rows[0] ? inputsTable(rows[0].inputs) : h('p', { text: 'Not found.' }));
      host.appendChild(h('button', { type: 'button', class: 'sm', text: 'Close', onclick: function () { host.hidden = true; clear(host); } }));
    }, function (e) { host.hidden = true; fail(e); });
  }

  // ---- details
  function simpleTable(cols, rows) {
    var t = h('table', null, [h('thead', null, [h('tr', null, cols.map(function (c) { return h('th', { text: c }); }))]), h('tbody', null, rows)]);
    return h('div', { class: 'wrap' }, [t]);
  }
  function showDetails(u) {
    openUser = u;
    var d = clear($('detail')); d.hidden = false;
    d.appendChild(h('h2', { text: 'Details: ' + nameOf(u) + ' (' + u.email + ')' }));
    d.appendChild(h('p', { class: 'muted', text: 'Loading…' }));
    var uid = encodeURIComponent(u.user_id), inputsHost = h('div', { hidden: 'hidden' });
    Promise.all([
      Auth.rest('/calculations?user_id=eq.' + uid + '&select=id,created_at,flight_date,dep_time,route,reg&order=created_at.desc&limit=100'),
      Auth.rest('/token_ledger?user_id=eq.' + uid + '&select=id,created_at,delta,reason,note,calculation_id,admin_id&order=created_at.desc&limit=100')
    ]).then(function (res) {
      if (openUser !== u) return;
      clear(d);
      d.appendChild(h('h2', { text: 'Details: ' + nameOf(u) + ' (' + u.email + ') — ' + u.tokens + ' tokens' }));
      d.appendChild(h('h2', { text: 'Last calculations (' + res[0].length + ')' }));
      d.appendChild(simpleTable(['Created', 'Flight date', 'Dep.', 'Route', 'Reg', ''], res[0].map(function (c) {
        return h('tr', null, [td(fmtDT(c.created_at)), td(c.flight_date || ''), td(c.dep_time || ''), td(c.route || ''), td(c.reg || ''),
          h('td', null, [h('button', { type: 'button', class: 'sm', text: 'View inputs', onclick: function () { viewInputs(c.id, inputsHost); } })])]);
      })));
      d.appendChild(inputsHost);
      var names = {}; users.forEach(function (x) { names[x.user_id] = nameOf(x); });
      d.appendChild(h('h2', { text: 'Token ledger (' + res[1].length + ')', style: 'margin-top:12px' }));
      d.appendChild(simpleTable(['Date', 'Change', 'Reason', 'Calc', 'By', 'Note'], res[1].map(function (l) {
        return h('tr', null, [td(fmtDT(l.created_at)), td((l.delta > 0 ? '+' : '') + l.delta, l.delta > 0 ? 'pos' : 'neg'), td(l.reason),
          td(l.calculation_id ? '#' + l.calculation_id : ''), td(l.admin_id ? names[l.admin_id] || 'admin' : ''), td(l.note || '')]);
      })));
      d.appendChild(h('button', { type: 'button', class: 'sm', style: 'margin-top:8px', text: 'Close details', onclick: function () { openUser = null; d.hidden = true; clear(d); } }));
      d.scrollIntoView && d.scrollIntoView({ block: 'nearest' });
    }, function (e) { d.hidden = true; fail(e); });
  }

  // ---- calculation log
  function fillUserSelect() {
    var s = $('lUser'), cur = s.value; clear(s);
    s.appendChild(h('option', { value: '', text: 'All users' }));
    users.slice().sort(function (a, b) { return nameOf(a).toLowerCase() < nameOf(b).toLowerCase() ? -1 : 1; }).forEach(function (u) {
      s.appendChild(h('option', { value: u.user_id, text: nameOf(u) + (u.name ? ' <' + u.email + '>' : '') }));
    });
    s.value = cur;
  }
  function loadLog() {
    var q = ['select=id,created_at,flight_date,dep_time,route,reg,user_id', 'order=created_at.desc', 'limit=200'];
    if ($('lUser').value) q.push('user_id=eq.' + encodeURIComponent($('lUser').value));
    if ($('lFrom').value) q.push('created_at=gte.' + encodeURIComponent(dayStart($('lFrom').value).toISOString()));
    if ($('lTo').value) q.push('created_at=lt.' + encodeURIComponent(nextDay(dayStart($('lTo').value)).toISOString()));
    var route = $('lRoute').value.trim(), reg = $('lReg').value.trim();
    if (route) q.push('route=ilike.' + encodeURIComponent('*' + route + '*'));
    if (reg) q.push('reg=eq.' + encodeURIComponent(reg));
    say('Loading…');
    Auth.rest('/calculations?' + q.join('&')).then(function (rows) {
      say(rows.length === 200 ? 'Showing the latest 200 matches.' : '');
      var by = {}; users.forEach(function (u) { by[u.user_id] = u; });
      var t = clear($('logTbl'));
      t.appendChild(h('thead', null, [h('tr', null, ['Created', 'User', 'Flight date', 'Dep.', 'Route', 'Reg', ''].map(function (c) { return h('th', { text: c }); }))]));
      t.appendChild(h('tbody', null, rows.map(function (c) {
        var u = by[c.user_id];
        return h('tr', null, [td(fmtDT(c.created_at)), td(u ? nameOf(u) : c.user_id), td(c.flight_date || ''), td(c.dep_time || ''), td(c.route || ''), td(c.reg || ''),
          h('td', null, [h('button', { type: 'button', class: 'sm', text: 'View inputs', onclick: function () { viewInputs(c.id, $('logInputs')); } })])]);
      })));
    }, fail);
  }

  // ---- invite
  function invite(e) {
    e.preventDefault();
    var email = $('iEmail').value.trim(), name = $('iName').value.trim(), tokens = parseInt($('iTokens').value || '0', 10);
    if (!(tokens >= 0 && tokens <= 1000)) return say('Tokens must be 0 to 1000.', 'err');
    var btn = e.target.querySelector('button'); btn.disabled = true; say('Sending invite…');
    Auth.token().then(function (t) {
      return fetch('/api/admin/invite', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body: JSON.stringify({ email: email, name: name || undefined, tokens: tokens }) });
    }).then(function (r) {
      return r.text().then(function (txt) {
        var j = null; try { j = JSON.parse(txt); } catch (x) { /* not json */ }
        if (!r.ok) throw Object.assign(new Error((j && (ERR[j.error] || j.message || j.error)) || ('Request failed (' + r.status + ')')), { apiDetail: true });
        return j;
      });
    }).then(function () {
      btn.disabled = false; say('Invite sent to ' + email + '.', 'ok'); e.target.reset(); $('iTokens').value = '0'; return loadUsage().then(function () { say('Invite sent to ' + email + '.', 'ok'); });
    }, function (err) { btn.disabled = false; say(err.message, 'err'); });
  }

  // ---- init
  function tab(name) {
    ['usage', 'log', 'invite'].forEach(function (t) { $('tab-' + t).hidden = t !== name; });
    document.querySelectorAll('.tabs button').forEach(function (b) { b.className = b.getAttribute('data-tab') === name ? 'on' : ''; });
    if (name === 'log' && !$('logTbl').firstChild) loadLog();
  }
  function init(r) {
    $('who').textContent = r.profile.name || r.profile.email || '';
    $('app').hidden = false;
    $('signout').onclick = function () { Auth.signOut(); };
    document.querySelectorAll('.tabs button').forEach(function (b) { b.onclick = function () { tab(b.getAttribute('data-tab')); }; });
    $('period').onchange = function () { var c = $('period').value === 'custom'; document.querySelectorAll('.cust').forEach(function (l) { l.hidden = !c; }); if (!c) loadUsage(); };
    $('pFrom').onchange = $('pTo').onchange = function () { if ($('pFrom').value && $('pTo').value) loadUsage(); };
    $('reload').onclick = loadUsage;
    $('lGo').onclick = loadLog;
    $('fInvite').onsubmit = invite;
    loadUsage();
  }
  if (!window.SB_CONFIG || !SB_CONFIG.url || !SB_CONFIG.anonKey) { document.body.textContent = 'Not configured.'; return; }
  Auth.requireAdmin().then(init, function (e) { document.getElementById('app').hidden = false; say(errMsg(e), 'err'); });
})();
