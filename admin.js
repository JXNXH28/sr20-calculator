// Admin dashboard: overview, users, calculation log, invites. Plain DOM, inline SVG, no libraries.
// All server strings are inserted with textContent (see h()/sv()); there is no innerHTML anywhere.
(function () {
  'use strict';

  // ================================================================ helpers
  var SVGNS = 'http://www.w3.org/2000/svg';
  var $ = function (id) { return document.getElementById(id); };
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var FULLWD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var LOW = 3;

  function append(e, kids) {
    (kids || []).forEach(function (c) { if (c != null && c !== false) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (k === 'text') e.textContent = v; else if (k === 'class') e.className = v;
      else if (k.slice(0, 2) === 'on') e[k] = v; else if (v !== false && v != null) e.setAttribute(k, v);
    });
    return append(e, kids);
  }
  function sv(tag, attrs, kids) {
    var e = document.createElementNS(SVGNS, tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'text') e.textContent = v; else e.setAttribute(k, v);
    });
    return append(e, kids);
  }
  function clear(e) { while (e.firstChild) e.removeChild(e.firstChild); return e; }
  function nf(n) { return (Math.round((+n || 0) * 10) / 10).toLocaleString(); }
  function plural(n, w) { return nf(n) + ' ' + w + (n === 1 ? '' : 's'); }
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  function sod(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
  function dayKey(d) { return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
  function dayStart(v) { var p = v.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function fmtDT(s) {
    if (!s) return '—';
    var d = new Date(s); if (isNaN(d)) return '';
    return dayKey(d) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }
  function fmtD(s) { var d = s ? new Date(s) : null; return d && !isNaN(d) ? dayKey(d) : '—'; }
  function dayLabel(d) { return d.getDate() + ' ' + MON[d.getMonth()]; }
  function rel(s) {
    if (!s) return 'Never';
    var t = new Date(s).getTime(); if (isNaN(t)) return '';
    var m = Math.floor((Date.now() - t) / 6e4);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    var hr = Math.floor(m / 60); if (hr < 24) return hr + ' h ago';
    var d = Math.floor(hr / 24); if (d < 30) return d + ' d ago';
    if (d < 365) return Math.floor(d / 30) + ' mo ago';
    return Math.floor(d / 365) + ' y ago';
  }
  function nameOf(u) { return (u && (u.name || u.email)) || ''; }
  function initials(u) {
    var n = (u && u.name || '').trim();
    if (n) { var p = n.split(/\s+/); return ((p[0][0] || '') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase(); }
    return String((u && u.email) || '?').slice(0, 2).toUpperCase();
  }
  function avatar(u, lg) { return h('span', { class: 'av' + (lg ? ' lg' : ''), 'aria-hidden': 'true', text: initials(u) }); }
  function chip(text, cls) { return h('span', { class: 'chip' + (cls ? ' ' + cls : ''), text: text }); }
  function sum(a, f) { var s = 0; a.forEach(function (x) { s += f(x); }); return s; }
  function meId() { var s = (window.Auth && Auth.session && Auth.session()) || {}; return (s.user || {}).id; }

  var ERR = {
    insufficient_tokens: 'Not enough tokens: the balance cannot go below zero.',
    forbidden: 'You are not allowed to do that.',
    invalid_role: 'Invalid role.',
    cannot_modify_self: 'You cannot change your own access.',
    already_registered: 'That email address is already registered.',
    invalid_email: 'Enter a valid email address.', invalid_name: 'Name is too long (max 100 characters).',
    invalid_tokens: 'Tokens must be a whole number from 0 to 1000.', unauthenticated: 'Session expired. Sign in again.'
  };
  function errMsg(e) { var m = e && e.message || 'Something went wrong.'; return ERR[m] || m; }
  var sayTimer = null;
  function say(text, kind) {
    var s = $('status'); clearTimeout(sayTimer);
    s.textContent = text || ''; s.hidden = !text; s.className = kind || '';
    if (text && kind === 'ok') sayTimer = setTimeout(function () { s.hidden = true; }, 5000);
  }
  function fail(e) {
    if (e && e.message === 'forbidden' && !e.apiDetail) { location.replace('/'); return; }
    say(errMsg(e), 'err');
  }

  // ================================================================ state
  var PREF = 'sr20.admin.prefs';
  var PERIODS = [['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['month', 'This month'], ['lastmonth', 'Last month'], ['90d', 'Last 90 days'], ['custom', 'Custom range…']];
  var VIEWS = ['overview', 'users', 'calcs', 'invite'];
  var state = { view: 'overview', pkey: '30d', pFrom: '', pTo: '', range: null, data: null, loading: false, err: null, seq: 0, cache: {}, uq: '', usort: 'active' };
  var L = { rows: [], shown: 0, limited: false, dirty: true, touched: false, loading: false, seq: 0, loaded: false };

  function loadPrefs() {
    try {
      var p = JSON.parse(localStorage.getItem(PREF) || '{}');
      if (VIEWS.indexOf(p.view) >= 0) state.view = p.view;
      if (PERIODS.some(function (x) { return x[0] === p.pkey; })) state.pkey = p.pkey;
      if (typeof p.pFrom === 'string') state.pFrom = p.pFrom;
      if (typeof p.pTo === 'string') state.pTo = p.pTo;
    } catch (e) { /* storage unavailable */ }
  }
  function savePrefs() {
    try { localStorage.setItem(PREF, JSON.stringify({ view: state.view, pkey: state.pkey, pFrom: state.pFrom, pTo: state.pTo })); } catch (e) { /* ignore */ }
  }

  // ================================================================ period
  function computeRange() {
    var now = new Date(), today = sod(now), tom = addDays(today, 1), from, to, k = state.pkey;
    if (k === '7d') { from = addDays(today, -6); to = tom; }
    else if (k === '30d') { from = addDays(today, -29); to = tom; }
    else if (k === '90d') { from = addDays(today, -89); to = tom; }
    else if (k === 'month') { from = new Date(now.getFullYear(), now.getMonth(), 1); to = tom; }
    else if (k === 'lastmonth') { from = new Date(now.getFullYear(), now.getMonth() - 1, 1); to = new Date(now.getFullYear(), now.getMonth(), 1); }
    else {
      if (!state.pFrom || !state.pTo) throw new Error('Pick both dates.');
      from = dayStart(state.pFrom); to = addDays(dayStart(state.pTo), 1);
      if (to <= from) throw new Error('The end date must not be before the start date.');
    }
    var days = Math.max(1, Math.round((to - from) / 864e5));
    return { from: from, to: to, days: days, pfrom: addDays(from, -days), pto: from, label: periodLabel(from, to) };
  }
  function periodLabel(from, to) {
    var last = new Date(to.getTime() - 1);
    return dayLabel(from) + (from.getFullYear() !== last.getFullYear() ? ' ' + from.getFullYear() : '') + ' – ' + dayLabel(last) + ' ' + last.getFullYear();
  }

  // ================================================================ data
  function calcUrl(from, to, limit) {
    return '/calculations?select=id,created_at,user_id,flight_date,dep_time,route,reg&created_at=gte.' + encodeURIComponent(from.toISOString()) +
      '&created_at=lt.' + encodeURIComponent(to.toISOString()) + '&order=created_at.desc&limit=' + limit;
  }
  function ledgerUrl(from, to) {
    return '/token_ledger?select=user_id,delta,reason,created_at&created_at=gte.' + encodeURIComponent(from.toISOString()) +
      '&created_at=lt.' + encodeURIComponent(to.toISOString()) + '&limit=10000';
  }
  function stamp(rows) { (rows || []).forEach(function (r) { r._t = new Date(r.created_at).getTime(); }); return rows || []; }

  function load(force) {
    var r;
    try { r = computeRange(); } catch (e) { return say(e.message, 'err'); }
    savePrefs();
    state.range = r; state.err = null;
    var key = r.from.getTime() + '_' + r.to.getTime();
    if (force) delete state.cache[key];
    L.touched = false; L.dirty = true;
    syncLogDates();
    if (state.cache[key]) { state.data = state.cache[key]; state.loading = false; say(''); afterData(); return; }
    var seq = ++state.seq, today = sod(new Date()), sf = addDays(today, -29), st = addDays(today, 1);
    var covers = r.pfrom <= sf && r.to >= st;
    state.data = null; state.loading = true; say(''); renderAll();
    return Promise.all([
      Auth.rpc('admin_usage', { p_from: r.from.toISOString(), p_to: r.to.toISOString() }),
      Auth.rest(calcUrl(r.pfrom, r.to, 5000)),
      Auth.rest(ledgerUrl(r.pfrom, r.to)),
      covers ? null : Auth.rest(calcUrl(sf, st, 5000))
    ]).then(function (res) {
      if (seq !== state.seq) return;
      var users = res[0] || [], calcs = stamp(res[1]), byId = {};
      users.forEach(function (u) { byId[u.user_id] = u; });
      var d = { range: r, users: users, byId: byId, calcs: calcs, ledger: stamp(res[2]), truncated: calcs.length >= 5000, dv: null, sp: null };
      d.sparkRows = res[3] ? stamp(res[3]) : calcs;
      state.cache[key] = d; state.data = d; state.loading = false;
      afterData();
    }, function (e) {
      if (seq !== state.seq) return;
      state.loading = false; state.err = e; renderAll(); fail(e);
    });
  }
  function afterData() {
    fillUserSelect(); renderAll();
    if (state.view === 'calcs' && L.dirty) loadLog();
  }
  // After a mutation the other cached periods would be stale.
  function dropOtherCaches() {
    var d = state.data, keep = {};
    Object.keys(state.cache).forEach(function (k) { if (state.cache[k] === d) keep[k] = d; });
    state.cache = keep;
  }

  function inRange(t, a, b) { return t >= a.getTime() && t < b.getTime(); }
  function stops(route) { return String(route || '').toUpperCase().split(/\s*(?:-|→|>)\s*/).map(function (s) { return s.trim(); }).filter(Boolean); }
  function top(map, n) {
    return Object.keys(map).map(function (k) { return { k: k, v: map[k] }; }).sort(function (a, b) { return b.v.n - a.v.n || (a.k < b.k ? -1 : 1); }).slice(0, n);
  }
  // Everything the overview shows, derived once per data set.
  function derive(d) {
    if (d.dv) return d.dv;
    var R = d.range, v = { cur: [], prev: [] }, i;
    d.calcs.forEach(function (c) {
      if (inRange(c._t, R.from, R.to)) v.cur.push(c); else if (inRange(c._t, R.pfrom, R.pto)) v.prev.push(c);
    });
    function distinct(rows) { var m = {}; rows.forEach(function (c) { m[c.user_id] = (m[c.user_id] || 0) + 1; }); return m; }
    v.curUsers = distinct(v.cur); v.prevUsers = distinct(v.prev);
    v.active = Object.keys(v.curUsers).length; v.pactive = Object.keys(v.prevUsers).length;
    v.used = 0; v.granted = 0; v.pused = 0; v.pgranted = 0;
    d.ledger.forEach(function (l) {
      var cur = inRange(l._t, R.from, R.to), prev = !cur && inRange(l._t, R.pfrom, R.pto);
      if (!cur && !prev) return;
      if (l.reason === 'calc') { if (cur) v.used -= l.delta; else v.pused -= l.delta; }
      else if (l.reason === 'grant') { if (cur) v.granted += l.delta; else v.pgranted += l.delta; }
    });
    v.outstanding = sum(d.users, function (u) { return +u.tokens || 0; });
    v.avg = v.active ? v.cur.length / v.active : 0; v.pavg = v.pactive ? v.prev.length / v.pactive : 0;
    // per-day buckets (viewer's local date)
    var byDay = {}; v.cur.forEach(function (c) { var k = dayKey(new Date(c._t)); byDay[k] = (byDay[k] || 0) + 1; });
    v.days = [];
    for (i = 0; i < 400; i++) {
      var day = addDays(R.from, i); if (day >= R.to) break;
      v.days.push({ date: day, v: byDay[dayKey(day)] || 0 });
    }
    // airports / aircraft / routes
    var ap = {}, ac = {}, rt = {}, hours = [], wd = [0, 0, 0, 0, 0, 0, 0];
    for (i = 0; i < 24; i++) hours.push(0);
    v.cur.forEach(function (c) {
      var s = stops(c.route);
      s.forEach(function (code, j) {
        var o = ap[code] || (ap[code] = { n: 0, dep: 0, arr: 0 });
        o.n++; if (j === s.length - 1 && s.length > 1) o.arr++; else o.dep++;
      });
      if (s.length) { var rk = s.join('-'); (rt[rk] = rt[rk] || { n: 0 }).n++; }
      var reg = String(c.reg || '').trim().toUpperCase(); if (reg) (ac[reg] = ac[reg] || { n: 0 }).n++;
      var m = /^(\d{1,2}):/.exec(c.dep_time || ''); if (m && +m[1] < 24) hours[+m[1]]++;
      var fd = /^(\d{4})-(\d{2})-(\d{2})/.exec(c.flight_date || '');
      if (fd) wd[(new Date(+fd[1], +fd[2] - 1, +fd[3]).getDay() + 6) % 7]++;
    });
    v.airports = top(ap, 8); v.aircraft = top(ac, 6); v.routes = top(rt, 6); v.hours = hours; v.wd = wd;
    v.topUsers = Object.keys(v.curUsers).map(function (id) { return { id: id, n: v.curUsers[id] }; })
      .sort(function (a, b) { return b.n - a.n; }).slice(0, 8);
    var att = { low: [], idle: [], invited: [], disabled: [] };
    d.users.forEach(function (u) {
      if (u.disabled) { att.disabled.push(u); return; }
      if ((+u.tokens || 0) <= LOW) att.low.push(u);
      if ((u.calcs_total || 0) === 0) att.invited.push(u); else if ((u.calcs_month || 0) === 0) att.idle.push(u);
    });
    att.low.sort(function (a, b) { return a.tokens - b.tokens; });
    v.att = att;
    d.dv = v; return v;
  }
  function sparkOf(d, uid) {
    if (!d.sp) {
      var start = addDays(sod(new Date()), -29).getTime(), m = {};
      d.sparkRows.forEach(function (c) {
        var i = Math.floor((sod(new Date(c._t)).getTime() - start) / 864e5 + 0.5);
        if (i < 0 || i > 29) return;
        (m[c.user_id] = m[c.user_id] || (function () { var a = []; for (var k = 0; k < 30; k++) a.push(0); return a; })())[i]++;
      });
      d.sp = m;
    }
    return d.sp[uid] || null;
  }

  // ================================================================ charts
  function niceTicks(max) {
    if (max < 1) max = 1;
    var raw = max / 3, mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10)), n = raw / mag;
    var step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
    if (step < 1) step = 1;
    var topv = Math.ceil(max / step) * step; if (topv / step < 2) topv = step * 2;
    var t = []; for (var v = 0; v <= topv + 1e-9; v += step) t.push(v);
    return t;
  }
  function colPath(x, y, w, hh) {
    var r = Math.min(2, w / 2, hh);
    return 'M' + x + ',' + (y + hh) + 'V' + (y + r) + 'Q' + x + ',' + y + ' ' + (x + r) + ',' + y + 'H' + (x + w - r) + 'Q' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y + r) + 'V' + (y + hh) + 'Z';
  }
  // o: {items:[{l,tip,v}], unit, aria, height, lw (min px per x label), color}
  function chartHost(o) { var host = h('div', { class: 'chart' }); host._o = o; return host; }
  function drawChart(host) {
    var o = host._o; if (!o) return;
    clear(host);
    var items = o.items, n = items.length, W = Math.max(240, Math.round(host.clientWidth || 600)), H = o.height || 200;
    var ml = 30, mr = 6, mt = 10, mb = 22, pw = W - ml - mr, ph = H - mt - mb, pitch = pw / Math.max(1, n);
    var max = 0; items.forEach(function (it) { max = Math.max(max, it.v); });
    var ticks = niceTicks(max), topv = ticks[ticks.length - 1];
    var y = function (v) { return mt + ph * (1 - v / topv); };
    var svg = sv('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', tabindex: '0', 'aria-label': o.aria });
    ticks.forEach(function (t) {
      svg.appendChild(sv('line', { x1: ml, x2: W - mr, y1: y(t), y2: y(t), stroke: 'var(--line)', 'stroke-width': t === 0 ? 1.5 : 1 }));
      svg.appendChild(sv('text', { x: ml - 6, y: y(t) + 4, 'text-anchor': 'end', text: nf(t) }));
    });
    var hl = sv('rect', { y: mt, height: ph, fill: 'var(--acc-soft)', display: 'none' });
    svg.appendChild(hl);
    var bw = Math.max(1.5, Math.min(28, pitch * 0.72)), every = Math.max(1, Math.ceil((o.lw || 44) / pitch));
    items.forEach(function (it, i) {
      var cx = ml + (i + 0.5) * pitch;
      if (it.v > 0) {
        var bh = Math.max(1.5, ph * it.v / topv);
        svg.appendChild(sv('path', { d: colPath(+(cx - bw / 2).toFixed(2), +(mt + ph - bh).toFixed(2), +bw.toFixed(2), +bh.toFixed(2)), fill: o.color || 'var(--acc)' }));
      }
      if (i % every === 0 && it.l != null) svg.appendChild(sv('text', { x: cx, y: H - 6, 'text-anchor': 'middle', text: it.l }));
    });
    var tip = h('div', { class: 'tip', hidden: 'hidden' });
    var cur = -1;
    function hide() { cur = -1; hl.setAttribute('display', 'none'); tip.hidden = true; }
    function show(i) {
      if (i < 0 || i >= n) return hide();
      cur = i; var it = items[i];
      hl.setAttribute('x', ml + i * pitch); hl.setAttribute('width', pitch); hl.setAttribute('display', 'inline');
      clear(tip).appendChild(h('b', { text: it.tip || it.l })); tip.appendChild(document.createTextNode(plural(it.v, o.unit)));
      tip.hidden = false;
      var tw = tip.offsetWidth, cx = ml + (i + 0.5) * pitch;
      tip.style.left = Math.min(Math.max(cx, tw / 2), W - tw / 2) + 'px';
      tip.style.top = Math.max(0, y(it.v) - tip.offsetHeight - 6) + 'px';
    }
    svg.addEventListener('pointermove', function (ev) {
      var r = svg.getBoundingClientRect(), x = (ev.clientX - r.left) * (W / r.width);
      show(Math.floor((x - ml) / pitch));
    });
    svg.addEventListener('pointerleave', hide);
    svg.addEventListener('focus', function () { if (cur < 0) show(n - 1); });
    svg.addEventListener('blur', hide);
    svg.addEventListener('keydown', function (ev) {
      var k = ev.key, i = cur < 0 ? n - 1 : cur;
      if (k === 'ArrowLeft') i--; else if (k === 'ArrowRight') i++; else if (k === 'Home') i = 0; else if (k === 'End') i = n - 1;
      else if (k === 'Escape') { if (cur >= 0) { hide(); ev.stopPropagation(); } return; } else return;
      ev.preventDefault(); show(Math.max(0, Math.min(n - 1, i)));
    });
    host.appendChild(svg); host.appendChild(tip);
  }
  function flushCharts(root) { Array.prototype.forEach.call((root || document).querySelectorAll('.chart'), drawChart); }

  // scaleMax: shared across all rows so sparklines are comparable between users
  function sparkline(arr, label, scaleMax) {
    var W = 90, H = 24, max = Math.max(1, scaleMax || 0), svg;
    arr.forEach(function (v) { max = Math.max(max, v); });
    svg = sv('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, role: 'img', 'aria-label': label, class: 'mini' });
    svg.appendChild(sv('line', { x1: 0, x2: W, y1: H - 0.5, y2: H - 0.5, stroke: 'var(--line)', 'stroke-width': 1 }));
    arr.forEach(function (v, i) {
      if (!v) return;
      var bh = Math.max(2, (H - 3) * v / max);
      svg.appendChild(sv('rect', { x: i * 3, y: H - 1 - bh, width: 2, height: bh, rx: 1, fill: 'var(--acc)' }));
    });
    return svg;
  }

  // ================================================================ small components
  function skeleton(hh, cls) { return h('div', { class: 'sk ' + (cls || ''), style: 'height:' + hh + 'px', 'aria-hidden': 'true' }); }
  function card(title, cap, kids, cls) {
    var head = h('div', { class: 'ch' }, [h('h2', { text: title }), h('span', { class: 'sp2' }), cap ? h('span', { class: 'cap', text: cap }) : null]);
    return h('div', { class: 'card ' + (cls || '') }, [head].concat(kids || []));
  }
  function empty(text) { return h('p', { class: 'empty', text: text }); }
  function rankList(rows, max) {
    return h('ol', { class: 'rank' }, rows.map(function (r) {
      var lab = r.onclick ? h('button', { type: 'button', class: 'rl', text: r.label, onclick: r.onclick, 'data-fk': r.fk || false }) : h('span', { class: 'rl', text: r.label });
      return h('li', { class: 'rk' }, [lab,
        h('span', { class: 'rv' }, [String(r.n), r.sub ? h('small', { text: r.sub }) : null]),
        h('span', { class: 'rb', 'aria-hidden': 'true' }, [h('i', { style: 'width:' + (max ? Math.max(2, Math.round(r.n / max * 100)) : 0) + '%' })])]);
    }));
  }
  function routeEl(route) {
    var s = stops(route), e = h('span', { class: 'route' });
    if (!s.length) return append(e, ['—']);
    s.forEach(function (c, i) { if (i) e.appendChild(h('i', { text: '→', 'aria-label': 'to' })); e.appendChild(document.createTextNode(c)); });
    return e;
  }
  function delta(cur, prev) {
    if (!prev) return h('div', { class: 'kd flat', text: cur ? 'No data in the prior period' : 'No change' });
    var p = (cur - prev) / prev * 100, r = Math.round(p);
    if (r === 0) return h('div', { class: 'kd flat', text: '= same as prior period' });
    return h('div', { class: 'kd flat', text: (p > 0 ? '▲ +' : '▼ −') + Math.abs(r) + '% vs prior period' });
  }
  function kpi(label, value, small, dlt, sub) {
    return h('div', { class: 'kpi' }, [h('div', { class: 'kl', text: label }),
      h('div', { class: 'kn' }, [String(value), small ? h('small', { text: ' ' + small }) : null]), dlt, sub ? h('div', { class: 'ks', text: sub }) : null]);
  }

  // ================================================================ overview
  function renderOverview() {
    var host = clear($('v-overview'));
    if (state.loading || (!state.data && !state.err)) {
      var k = h('div', { class: 'kpis' }); for (var i = 0; i < 6; i++) k.appendChild(skeleton(104));
      var g = h('div', { class: 'grid', style: 'margin-top:12px' }); [260, 260, 200, 200, 200].forEach(function (x, j) { g.appendChild(skeleton(x, j === 0 ? 's2' : '')); });
      host.appendChild(k); host.appendChild(g); return;
    }
    if (!state.data) { host.appendChild(retry()); return; }
    var d = state.data, v = derive(d), R = d.range, nUsers = d.users.length;
    var wrap = h('div', { style: 'display:flex;flex-direction:column;gap:12px' });
    if (d.truncated) wrap.appendChild(h('p', { class: 'note', text: 'Calculation data is limited to the latest 5000 rows; figures for the earliest days may be incomplete.' }));
    wrap.appendChild(h('div', { class: 'kpis' }, [
      kpi('Calculations', nf(v.cur.length), '', delta(v.cur.length, v.prev.length), 'Prior: ' + nf(v.prev.length)),
      kpi('Active users', nf(v.active), '/ ' + nf(nUsers), delta(v.active, v.pactive), 'Prior: ' + nf(v.pactive)),
      kpi('Tokens used', nf(v.used), '', delta(v.used, v.pused), 'Prior: ' + nf(v.pused)),
      kpi('Tokens granted', nf(v.granted), '', delta(v.granted, v.pgranted), 'Prior: ' + nf(v.pgranted)),
      kpi('Tokens outstanding', nf(v.outstanding), '', h('div', { class: 'kd flat', text: 'Balances right now' }), 'Across ' + plural(nUsers, 'user')),
      kpi('Avg per active user', nf(v.avg), '', delta(v.avg, v.pavg), 'Prior: ' + nf(v.pavg))
    ]));
    var grid = h('div', { class: 'grid' });
    // calculations per day
    var chartCard = card('Calculations per day', R.label, [], 's2');
    var dayCap = nf(v.cur.length) + ' in this period · ' + nf(v.prev.length) + ' in the prior period of ' + R.days + ' days';
    if (!v.cur.length) chartCard.appendChild(empty('No calculations in this period'));
    else {
      var peak = v.days.reduce(function (a, b) { return b.v > a.v ? b : a; }, v.days[0]);
      var ch = chartHost({
        items: v.days.map(function (x) { return { l: dayLabel(x.date), tip: WD[x.date.getDay()] + ' ' + dayLabel(x.date) + ' ' + x.date.getFullYear(), v: x.v }; }),
        unit: 'calculation', height: 220, lw: 56,
        aria: 'Calculations per day, ' + R.label + ': ' + v.cur.length + ' in total, busiest day ' + dayLabel(peak.date) + ' with ' + peak.v + '. Prior period: ' + v.prev.length + '.'
      });
      chartCard.appendChild(ch);
    }
    chartCard.appendChild(h('p', { class: 'note', style: 'margin-top:8px', text: dayCap }));
    grid.appendChild(chartCard);
    // who flies most
    var who = card('Who flies most', 'Top 8 · share of period', []);
    if (!v.topUsers.length) who.appendChild(empty('No calculations in this period'));
    else who.appendChild(rankList(v.topUsers.map(function (t) {
      var u = d.byId[t.id];
      return { label: u ? nameOf(u) : t.id, n: t.n, sub: Math.round(t.n / v.cur.length * 100) + '%', onclick: function (ev) { showUser(t.id, ev.currentTarget); }, fk: 'u:' + t.id };
    }), v.topUsers[0].n));
    grid.appendChild(who);
    // needs attention
    grid.appendChild(attentionCard(d, v));
    // airports, aircraft, routes
    grid.appendChild(listCard('Top airports', 'Departures and arrivals', v.airports, 'No airports in this period', function (t) { return { label: t.k, n: t.v.n, sub: t.v.dep + ' dep / ' + t.v.arr + ' arr' }; }));
    grid.appendChild(listCard('Top aircraft', 'By registration', v.aircraft, 'No aircraft in this period', function (t) { return { label: t.k, n: t.v.n }; }));
    grid.appendChild(listCard('Top routes', 'Most calculated', v.routes, 'No routes in this period', function (t) { return { label: t.k.split('-').join(' → '), n: t.v.n }; }));
    // when people fly
    var hc = card('When people fly', 'Departure hour, local airport time', [], 's2');
    var hasH = v.hours.some(function (x) { return x > 0; });
    if (!hasH) hc.appendChild(empty('No departure times in this period'));
    else {
      var bh = v.hours.indexOf(Math.max.apply(null, v.hours));
      hc.appendChild(chartHost({
        items: v.hours.map(function (x, i) { return { l: p2(i), tip: p2(i) + ':00 – ' + p2(i) + ':59', v: x }; }),
        unit: 'departure', height: 170, lw: 26, color: 'var(--acc)',
        aria: 'Departures by hour of day. Busiest hour ' + p2(bh) + ':00 with ' + v.hours[bh] + ' departures.'
      }));
    }
    grid.appendChild(hc);
    var wc = card('Day of week', 'By flight date', []);
    if (!v.wd.some(function (x) { return x > 0; })) wc.appendChild(empty('No flight dates in this period'));
    else {
      var order = [1, 2, 3, 4, 5, 6, 0], bi = v.wd.indexOf(Math.max.apply(null, v.wd));
      wc.appendChild(chartHost({
        items: v.wd.map(function (x, i) { var nm = WD[order[i]]; return { l: nm, tip: FULLWD[order[i]], v: x }; }),
        unit: 'flight', height: 170, lw: 30,
        aria: 'Flights by day of week. Busiest ' + WD[order[bi]] + ' with ' + v.wd[bi] + '.'
      }));
    }
    grid.appendChild(wc);
    wrap.appendChild(grid); host.appendChild(wrap);
    flushCharts(host);
  }
  function listCard(title, cap, rows, emptyMsg, map) {
    var c = card(title, cap, []);
    if (!rows.length) { c.appendChild(empty(emptyMsg)); return c; }
    var items = rows.map(map);
    c.appendChild(rankList(items, items[0].n)); return c;
  }
  function attentionCard(d, v) {
    var A = v.att, c = card('Needs attention', 'Click a name to open the user', [], 's3');
    var total = A.low.length + A.idle.length + A.invited.length + A.disabled.length;
    var g = h('div', { class: 'att' });
    function group(title, list, extra, detail) {
      var ul = h('ul');
      list.slice(0, 5).forEach(function (u) {
        var li = h('li', null, [h('button', { type: 'button', class: 'nm', text: nameOf(u), 'data-fk': 'u:' + u.user_id, onclick: function (ev) { showUser(u.user_id, ev.currentTarget); } }),
          h('span', { class: 'dt', text: detail(u) })]);
        if (extra) li.appendChild(extra(u));
        ul.appendChild(li);
      });
      var box = h('div', null, [h('h3', null, [title, h('span', { class: 'cnt', text: String(list.length) })])]);
      if (!list.length) box.appendChild(h('p', { class: 'note', text: 'None' })); else box.appendChild(ul);
      if (list.length > 5) box.appendChild(h('button', { type: 'button', class: 'sm ghost', text: '+' + (list.length - 5) + ' more in Users', onclick: function () { state.uq = ''; $('uq').value = ''; setView('users'); } }));
      return box;
    }
    g.appendChild(group('Low balance (≤ ' + LOW + ')', A.low, function (u) {
      return h('button', { type: 'button', class: 'sm', text: '+10', title: 'Grant 10 tokens to ' + nameOf(u), 'aria-label': 'Grant 10 tokens to ' + nameOf(u),
        onclick: function (ev) { var b = ev.currentTarget; b.disabled = true; adjust(u, 10, 'quick grant').then(function () { b.disabled = false; }); } });
    }, function (u) { return plural(u.tokens, 'token'); }));
    g.appendChild(group('No calculation in 30 days', A.idle, null, function (u) { return 'last ' + rel(u.last_calc); }));
    g.appendChild(group('Invited, never calculated', A.invited, null, function (u) { return 'joined ' + rel(u.created_at); }));
    g.appendChild(group('Disabled', A.disabled, null, function (u) { return plural(u.tokens, 'token'); }));
    c.appendChild(g);
    if (!total) c.appendChild(h('p', { class: 'note', style: 'margin-top:8px', text: 'Everything looks fine.' }));
    return c;
  }
  function retry() {
    return h('div', { class: 'card' }, [empty('Could not load the data.'), h('div', { style: 'text-align:center' }, [h('button', { type: 'button', class: 'pri', text: 'Try again', onclick: function () { load(true); } })])]);
  }

  // ================================================================ users view
  function userSort(list) {
    var k = state.usort;
    function t(s) { return s ? new Date(s).getTime() : 0; }
    list.sort(function (a, b) {
      if (k === 'tokens') return (a.tokens - b.tokens) || (nameOf(a).toLowerCase() < nameOf(b).toLowerCase() ? -1 : 1);
      if (k === 'last') return t(b.last_calc) - t(a.last_calc);
      if (k === 'name') return nameOf(a).toLowerCase() < nameOf(b).toLowerCase() ? -1 : 1;
      return ((b.calcs_period || 0) - (a.calcs_period || 0)) || (t(b.last_calc) - t(a.last_calc));
    });
    return list;
  }
  function renderUsers() {
    var host = clear($('ulist'));
    if (state.loading || (!state.data && !state.err)) {
      for (var i = 0; i < 8; i++) host.appendChild(h('div', { style: 'margin-bottom:8px' }, [skeleton(40)]));
      $('ucount').textContent = ''; return;
    }
    if (!state.data) { host.appendChild(retry()); return; }
    var d = state.data, q = state.uq.trim().toLowerCase();
    var list = d.users.filter(function (u) { return !q || (u.name || '').toLowerCase().indexOf(q) >= 0 || (u.email || '').toLowerCase().indexOf(q) >= 0; });
    userSort(list);
    $('ucount').textContent = 'Showing ' + list.length + ' of ' + d.users.length + ' users · ' + d.range.label;
    if (!list.length) { host.appendChild(empty(d.users.length ? 'No user matches your search.' : 'No users yet. Invite someone to get started.')); return; }
    var head = h('div', { class: 'uhead', 'aria-hidden': 'true' }, ['', 'User', 'Status', 'Tokens', 'Period', 'Last 30 days', 'Last calc', ''].map(function (t, i) { return h('span', { text: t, class: i === 3 || i === 4 ? 'n' : '' }); }));
    host.appendChild(head);
    var sparkMax = 1;
    list.forEach(function (u) { (sparkOf(d, u.user_id) || []).forEach(function (v) { sparkMax = Math.max(sparkMax, v); }); });
    list.forEach(function (u) {
      var sp = sparkOf(d, u.user_id) || (function () { var a = []; for (var k = 0; k < 30; k++) a.push(0); return a; })();
      var total30 = sum(sp, function (x) { return x; });
      var open = function (ev) { showUser(u.user_id, ev.currentTarget); };
      var nm = h('button', { type: 'button', class: 'nm', text: nameOf(u), 'data-fk': 'u:' + u.user_id, onclick: function (ev) { ev.stopPropagation(); open(ev); } });
      var row = h('div', { class: 'urow' + (u.disabled ? ' dis' : ''), onclick: function () { showUser(u.user_id, nm); } }, [
        avatar(u),
        h('div', { class: 'who2' }, [nm, h('span', { class: 'em', text: u.name ? u.email : '' })]),
        h('div', { class: 'ustats' }, [
          h('div', { class: 'chips' }, [u.role === 'admin' ? chip('Admin') : null, u.disabled ? chip('Disabled', 'off') : null, (!u.disabled && u.role !== 'admin' && !u.calcs_total) ? chip('Invited', 'warn') : null]),
          h('span', { class: 'n' + ((+u.tokens || 0) <= LOW ? ' low' : ''), title: 'Tokens left', text: nf(u.tokens) + ' tok' }),
          h('span', { class: 'n', title: 'Calculations in period', text: nf(u.calcs_period || 0) + ' calc' }),
          sparkline(sp, plural(total30, 'calculation') + ' in the last 30 days', sparkMax),
          h('span', { class: 'lastc', title: fmtDT(u.last_calc), text: u.last_calc ? rel(u.last_calc) : 'Never' })
        ]),
        h('button', { type: 'button', class: 'sm mg', text: 'Manage', 'aria-label': 'Manage ' + nameOf(u), onclick: function (ev) { ev.stopPropagation(); showUser(u.user_id, ev.currentTarget); } })
      ]);
      host.appendChild(row);
    });
  }

  // ================================================================ drawer
  var DR = { open: false, opener: null, fk: null, kind: null, uid: null, seq: 0 };
  function setInert(on) {
    ['topbar', 'main'].forEach(function (id) { var e = $(id); if (!e) return; if (on) e.setAttribute('inert', ''); else e.removeAttribute('inert'); });
    document.body.style.overflow = on ? 'hidden' : '';
  }
  function drawerOpen(opener, fk) {
    if (DR.open) return;
    DR.open = true; DR.opener = opener || document.activeElement; DR.fk = fk || null;
    $('drawer').classList.add('open'); $('scrim').classList.add('open'); $('drawer').setAttribute('aria-hidden', 'false'); setInert(true);
  }
  function drawerClose() {
    if (!DR.open) return;
    DR.open = false; DR.kind = null; DR.uid = null; DR.seq++;
    $('drawer').classList.remove('open'); $('scrim').classList.remove('open'); $('drawer').setAttribute('aria-hidden', 'true'); setInert(false);
    var t = DR.opener && DR.opener.isConnected ? DR.opener : null;
    if (!t && DR.fk) Array.prototype.forEach.call(document.querySelectorAll('[data-fk]'), function (e) { if (!t && e.getAttribute('data-fk') === DR.fk) t = e; });
    if (!t) t = document.querySelector('#nav [aria-current]');
    if (t && t.focus) t.focus();
    DR.opener = null;
  }
  function drawerContent(headKids, bodyKids) {
    var hd = append(clear($('dHead')), headKids), bd = append(clear($('dBody')), bodyKids);
    bd.scrollTop = 0;
    var t = $('dTitle'); if (t) t.focus();
    return bd;
  }
  function dHead(av, title, sub, chips, back) {
    return [back ? h('button', { type: 'button', class: 'sm', text: '← Back', onclick: back }) : null, av,
      h('div', { class: 't' }, [h('h2', { id: 'dTitle', tabindex: '-1', text: title }), h('div', { class: 'em', text: sub || '' })]),
      chips ? h('div', { class: 'chips' }, chips) : null,
      h('button', { type: 'button', class: 'sm', text: 'Close', 'aria-label': 'Close panel', onclick: drawerClose })];
  }
  function trapTab(ev) {
    if (ev.key !== 'Tab' || !DR.open) return;
    var f = Array.prototype.filter.call($('drawer').querySelectorAll('button,a[href],input,select,textarea,[tabindex]'), function (e) {
      return !e.disabled && e.getAttribute('tabindex') !== '-1' && e.offsetParent !== null;
    });
    if (!f.length) { ev.preventDefault(); return; }
    var first = f[0], last = f[f.length - 1], a = document.activeElement;
    if (ev.shiftKey && (a === first || !$('drawer').contains(a) || a.id === 'dTitle')) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && (a === last || !$('drawer').contains(a))) { ev.preventDefault(); first.focus(); }
  }

  function showUser(uid, opener) {
    var d = state.data, u = d && d.byId[uid]; if (!u) return;
    drawerOpen(opener, 'u:' + uid);
    DR.kind = 'user'; DR.uid = uid; var seq = ++DR.seq;
    var me = meId() === uid, v = derive(d);
    var tiles = h('div', { class: 'mt' }), lists = h('div', { style: 'display:flex;flex-direction:column;gap:20px' });
    var status = h('span', { class: 'chips' });
    var body = [];
    var fillTiles = function () {
      clear(tiles);
      [[nf(u.tokens), 'Tokens left'], [nf(u.calcs_period || 0), 'Calcs in period'], [nf(u.calcs_total || 0), 'Calcs total'],
        [nf(u.granted_total || 0), 'Tokens granted'], [fmtD(u.created_at), 'Member since'], [u.last_calc ? rel(u.last_calc) : 'Never', 'Last calc']].forEach(function (t) {
        tiles.appendChild(h('div', null, [h('b', { text: t[0] }), h('span', { text: t[1] })]));
      });
    };
    fillTiles();
    body.push(tiles);
    // per-day chart
    var mine = v.cur.filter(function (c) { return c.user_id === uid; }), bd = {};
    mine.forEach(function (c) { var k = dayKey(new Date(c._t)); bd[k] = (bd[k] || 0) + 1; });
    var cs = h('section', null, [h('h3', { text: 'Calculations per day · ' + d.range.label })]);
    if (!mine.length) cs.appendChild(empty('No calculations in this period'));
    else cs.appendChild(chartHost({
      items: v.days.map(function (x) { return { l: dayLabel(x.date), tip: WD[x.date.getDay()] + ' ' + dayLabel(x.date), v: bd[dayKey(x.date)] || 0 }; }),
      unit: 'calculation', height: 150, lw: 56, aria: nameOf(u) + ': ' + mine.length + ' calculations in the period.'
    }));
    body.push(cs);
    // token adjust
    var amt = h('input', { type: 'number', min: '1', step: '1', 'aria-label': 'Amount', placeholder: 'Amount' });
    var note = h('input', { type: 'text', class: 'nt', maxlength: '200', placeholder: 'Note (optional)', 'aria-label': 'Note' });
    var apply = function (sign, n, quick) {
      if (!(n >= 1) || n > 100000) return say('Enter a whole amount of at least 1.', 'err');
      var nt = note.value.trim() || (quick ? 'quick grant' : '');
      adjust(u, sign * n, nt).then(function (ok) { if (ok) { amt.value = ''; note.value = ''; } });
    };
    var quick = h('div', { class: 'qk' }, [h('span', { class: 'note', text: 'Quick grant' })].concat([5, 10, 25].map(function (n) {
      return h('button', { type: 'button', class: 'sm', text: '+' + n, onclick: function () { apply(1, n, true); } });
    })));
    body.push(h('section', null, [h('h3', { text: 'Tokens' }), h('div', { class: 'adj' }, [
      h('label', { class: 'f' }, ['Amount', amt]), h('label', { class: 'f', style: 'flex:1' }, ['Note', note]),
      h('button', { type: 'button', class: 'pri', text: '+ Add', onclick: function () { apply(1, parseInt(amt.value, 10)); } }),
      h('button', { type: 'button', text: '− Remove', onclick: function () { apply(-1, parseInt(amt.value, 10)); } })]), quick]));
    // access
    var access = h('div', { class: 'acts' }, [
      h('button', { type: 'button', class: u.disabled ? '' : 'danger', text: u.disabled ? 'Enable user' : 'Disable user', disabled: me ? 'disabled' : false, onclick: function () { setUser(u, { disabled: !u.disabled }); } }),
      h('button', { type: 'button', text: u.role === 'admin' ? 'Remove admin' : 'Make admin', disabled: me ? 'disabled' : false, onclick: function () { setUser(u, { role: u.role === 'admin' ? 'user' : 'admin' }); } })]);
    body.push(h('section', null, [h('h3', { text: 'Access' }), access, me ? h('p', { class: 'note', style: 'margin-top:6px', text: 'You cannot disable yourself or remove your own admin rights.' }) : null]));
    body.push(lists);
    var chips = [u.role === 'admin' ? chip('Admin') : null, u.disabled ? chip('Disabled', 'off') : null];
    var bodyEl = drawerContent(dHead(avatar(u, true), nameOf(u), u.name ? u.email : '', chips), body);
    flushCharts(bodyEl);
    DR.refresh = function () { fillTiles(); loadHistory(u, lists, seq); };
    loadHistory(u, lists, seq);
  }
  function loadHistory(u, host, seq) {
    var uid = encodeURIComponent(u.user_id);
    clear(host).appendChild(h('div', null, [skeleton(14), h('div', { style: 'height:6px' }), skeleton(14, ''), h('div', { style: 'height:6px' }), skeleton(14)]));
    Promise.all([
      Auth.rest('/calculations?user_id=eq.' + uid + '&select=id,created_at,flight_date,dep_time,route,reg&order=created_at.desc&limit=100'),
      Auth.rest('/token_ledger?user_id=eq.' + uid + '&select=id,created_at,delta,reason,note,calculation_id,admin_id&order=created_at.desc&limit=100')
    ]).then(function (res) {
      if (!DR.open || DR.seq !== seq) return;
      var names = {}; state.data.users.forEach(function (x) { names[x.user_id] = nameOf(x); });
      clear(host);
      var cs = h('section', null, [h('h3', { text: 'Calculations (' + res[0].length + (res[0].length >= 100 ? ', latest 100' : '') + ')' })]);
      if (!res[0].length) cs.appendChild(empty('No calculations yet')); else cs.appendChild(h('ul', { class: 'hl' }, res[0].map(function (c) {
        return h('li', null, [h('div', { class: 'g' }, [h('b', { class: 'route' }, [routeEl(c.route), c.reg ? '  · ' + c.reg : '']),
          h('span', { text: rel(c.created_at) + ' · ' + fmtDT(c.created_at) + (c.flight_date ? ' · flight ' + c.flight_date + (c.dep_time ? ' ' + c.dep_time : '') : '') })]),
          h('button', { type: 'button', class: 'sm', text: 'View inputs', 'data-fk': 'c:' + c.id, onclick: function () { showCalc(c.id, u.user_id); } })]);
      })));
      var ls = h('section', null, [h('h3', { text: 'Token ledger (' + res[1].length + (res[1].length >= 100 ? ', latest 100' : '') + ')' })]);
      if (!res[1].length) ls.appendChild(empty('No ledger entries')); else ls.appendChild(h('ul', { class: 'hl' }, res[1].map(function (l) {
        var by = l.admin_id ? (names[l.admin_id] || 'admin') : '';
        return h('li', null, [h('span', { class: l.delta > 0 ? 'pos' : 'neg', style: 'min-width:36px', text: (l.delta > 0 ? '+' : '') + l.delta }),
          h('div', { class: 'g' }, [h('b', { text: l.reason + (l.calculation_id ? ' #' + l.calculation_id : '') }),
            h('span', { text: rel(l.created_at) + ' · ' + fmtDT(l.created_at) + (by ? ' · by ' + by : '') + (l.note ? ' · ' + l.note : '') })])]);
      })));
      host.appendChild(cs); host.appendChild(ls);
    }, function (e) { if (DR.open && DR.seq === seq) { clear(host).appendChild(empty('Could not load history.')); fail(e); } });
  }

  // calculation inputs, shown in the drawer
  function humanKey(k) {
    var s = String(k).replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function humanVal(v) {
    if (v === true) return 'Yes'; if (v === false) return 'No'; if (v === null || v === undefined || v === '') return '—';
    return v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  function inputsGroups(inputs) {
    var groups = {}, order = [], flat = {};
    function add(prefix, v) {
      if (v && typeof v === 'object' && !Array.isArray(v) && prefix.split('.').length < 3) Object.keys(v).forEach(function (k) { add(prefix ? prefix + '.' + k : k, v[k]); });
      else flat[prefix] = v;
    }
    add('', inputs && typeof inputs === 'object' ? inputs : { value: inputs });
    Object.keys(flat).forEach(function (k) {
      var i = k.indexOf('.'), g = i < 0 ? 'General' : k.slice(0, i), name = i < 0 ? k : k.slice(i + 1);
      if (!groups[g]) { groups[g] = []; order.push(g); }
      groups[g].push([name, flat[k], k]);
    });
    order.sort(function (a, b) { return a === 'General' ? -1 : b === 'General' ? 1 : a < b ? -1 : a > b ? 1 : 0; });
    return order.map(function (g) {
      var dl = h('dl');
      groups[g].forEach(function (kv) { dl.appendChild(h('dt', { text: humanKey(kv[0]), title: kv[2] })); dl.appendChild(h('dd', { text: humanVal(kv[1]) })); });
      return h('div', { class: 'grp' }, [h('h4', { text: humanKey(g) }), dl]);
    });
  }
  function showCalc(id, backUid, opener) {
    var d = state.data, back = backUid ? function () { showUser(backUid); } : null;
    drawerOpen(opener, 'c:' + id);
    DR.kind = 'calc'; DR.uid = null; var seq = ++DR.seq;
    drawerContent(dHead(null, 'Calculation #' + id, '', null, back), [h('div', null, [skeleton(16), h('div', { style: 'height:8px' }), skeleton(120)])]);
    Auth.rest('/calculations?id=eq.' + encodeURIComponent(id) + '&select=id,user_id,created_at,flight_date,dep_time,route,reg,inputs').then(function (rows) {
      if (!DR.open || DR.seq !== seq) return;
      var c = rows && rows[0], u = c && d && d.byId[c.user_id];
      if (!c) { drawerContent(dHead(null, 'Calculation #' + id, '', null, back), [empty('Not found.')]); return; }
      var meta = h('div', { class: 'grp' }, [h('h4', { text: 'Summary' }), (function () {
        var dl = h('dl');
        [['User', u ? nameOf(u) : c.user_id], ['Created', fmtDT(c.created_at) + ' (' + rel(c.created_at) + ')'], ['Route', stops(c.route).join(' → ') || '—'],
          ['Registration', c.reg || '—'], ['Flight date', c.flight_date || '—'], ['Departure', c.dep_time || '—']].forEach(function (kv) { dl.appendChild(h('dt', { text: kv[0] })); dl.appendChild(h('dd', { text: kv[1] })); });
        return dl;
      })()]);
      drawerContent(dHead(u ? avatar(u, true) : null, 'Calculation #' + id, u ? nameOf(u) : '', null, back), [meta, h('section', null, [h('h3', { text: 'Inputs' })].concat(inputsGroups(c.inputs)))]);
    }, function (e) { if (DR.open && DR.seq === seq) { drawerContent(dHead(null, 'Calculation #' + id, '', null, back), [empty('Could not load inputs.')]); fail(e); } });
  }

  // ================================================================ mutations
  function adjust(u, delta, note) {
    say('');
    return Auth.rpc('admin_adjust_tokens', { p_user: u.user_id, p_delta: delta, p_note: note || null }).then(function (bal) {
      u.tokens = typeof bal === 'number' ? bal : u.tokens + delta;
      if (delta > 0) u.granted_total = (u.granted_total || 0) + delta;
      var d = state.data;
      if (d) { d.ledger.push({ user_id: u.user_id, delta: delta, reason: delta > 0 ? 'grant' : 'adjust', created_at: new Date().toISOString(), _t: Date.now() }); d.dv = null; }
      dropOtherCaches(); renderView();
      if (DR.open && DR.kind === 'user' && DR.uid === u.user_id && DR.refresh) DR.refresh();
      say(nameOf(u) + ': new balance ' + plural(u.tokens, 'token') + '.', 'ok');
      return true;
    }, function (e) { fail(e); return false; });
  }
  function setUser(u, ch) {
    var q = ch.disabled !== undefined ? (ch.disabled ? 'Disable ' : 'Enable ') + nameOf(u) + '?' + (ch.disabled ? ' They will be signed out of the calculator.' : '')
      : (ch.role === 'admin' ? 'Make ' + nameOf(u) + ' an admin?' : 'Remove admin rights from ' + nameOf(u) + '?');
    if (!confirm(q)) return;
    say('');
    Auth.rpc('admin_set_user', { p_user: u.user_id, p_disabled: ch.disabled === undefined ? null : ch.disabled, p_role: ch.role || null }).then(function () {
      if (ch.disabled !== undefined) u.disabled = ch.disabled;
      if (ch.role) u.role = ch.role;
      if (state.data) state.data.dv = null;
      dropOtherCaches(); renderView();
      if (DR.open && DR.kind === 'user' && DR.uid === u.user_id) showUser(u.user_id);
      say('Updated ' + nameOf(u) + '.', 'ok');
    }, fail);
  }

  // ================================================================ calculations log
  function fillUserSelect() {
    var s = $('lUser'), cur = s.value; clear(s);
    s.appendChild(h('option', { value: '', text: 'All users' }));
    if (state.data) state.data.users.slice().sort(function (a, b) { return nameOf(a).toLowerCase() < nameOf(b).toLowerCase() ? -1 : 1; }).forEach(function (u) {
      s.appendChild(h('option', { value: u.user_id, text: nameOf(u) + (u.name ? ' <' + u.email + '>' : '') }));
    });
    s.value = cur;
  }
  function syncLogDates() {
    if (L.touched || !state.range) return;
    $('lFrom').value = dayKey(state.range.from); $('lTo').value = dayKey(new Date(state.range.to.getTime() - 1));
  }
  function loadLog() {
    L.dirty = false;
    var q = ['select=id,created_at,flight_date,dep_time,route,reg,user_id', 'order=created_at.desc', 'limit=2000'];
    if ($('lUser').value) q.push('user_id=eq.' + encodeURIComponent($('lUser').value));
    if ($('lFrom').value) q.push('created_at=gte.' + encodeURIComponent(dayStart($('lFrom').value).toISOString()));
    if ($('lTo').value) q.push('created_at=lt.' + encodeURIComponent(addDays(dayStart($('lTo').value), 1).toISOString()));
    var route = $('lRoute').value.trim(), reg = $('lReg').value.trim();
    if (route) q.push('route=ilike.' + encodeURIComponent('*' + route + '*'));
    if (reg) q.push('reg=eq.' + encodeURIComponent(reg));
    var seq = ++L.seq; L.loading = true; renderLog();
    Auth.rest('/calculations?' + q.join('&')).then(function (rows) {
      if (seq !== L.seq) return;
      L.rows = stamp(rows); L.shown = Math.min(100, rows.length); L.limited = rows.length >= 2000; L.loading = false; L.loaded = true; renderLog();
    }, function (e) { if (seq !== L.seq) return; L.loading = false; L.loaded = true; L.rows = []; renderLog(); fail(e); });
  }
  function renderLog() {
    var host = clear($('clist')), cnt = $('lCount');
    if (L.loading) { cnt.textContent = ''; for (var i = 0; i < 6; i++) host.appendChild(h('div', { style: 'margin-bottom:8px' }, [skeleton(32)])); return; }
    var n = L.rows.length;
    cnt.textContent = n ? 'Showing ' + Math.min(L.shown, n) + ' of ' + nf(n) + (L.limited ? '+ (limited to the latest 2000 matches)' : '') + ' calculations' : '';
    if (!n) { host.appendChild(empty(L.loaded ? 'No calculations match these filters.' : '')); return; }
    var by = state.data ? state.data.byId : {};
    var tb = h('tbody');
    L.rows.slice(0, L.shown).forEach(function (c) {
      var u = by[c.user_id], b = h('button', { type: 'button', class: 'sm', text: 'Inputs', 'data-fk': 'c:' + c.id, 'aria-label': 'View inputs of calculation ' + c.id });
      b.onclick = function (ev) { ev.stopPropagation(); showCalc(c.id, null, b); };
      tb.appendChild(h('tr', { class: 'click', onclick: function () { showCalc(c.id, null, b); } }, [
        h('td', null, [rel(c.created_at), h('span', { class: 'sub', text: fmtDT(c.created_at) })]),
        h('td', { text: u ? nameOf(u) : c.user_id }),
        h('td', null, [routeEl(c.route)]),
        h('td', { text: c.reg || '—' }),
        h('td', null, [c.flight_date || '—', c.dep_time ? h('span', { class: 'sub', text: c.dep_time }) : null]),
        h('td', null, [b])
      ]));
    });
    host.appendChild(h('div', { class: 'tw' }, [h('table', null, [
      h('thead', null, [h('tr', null, ['When', 'User', 'Route', 'Reg', 'Flight', ''].map(function (t) { return h('th', { text: t }); }))]), tb])]));
    if (L.shown < n) host.appendChild(h('div', { class: 'more' }, [h('button', { type: 'button', text: 'Show ' + Math.min(100, n - L.shown) + ' more', onclick: function () { L.shown += 100; renderLog(); } })]));
  }

  // ================================================================ invite
  function invite(e) {
    e.preventDefault();
    var email = $('iEmail').value.trim(), name = $('iName').value.trim(), tokens = parseInt($('iTokens').value || '0', 10);
    if (!(tokens >= 0 && tokens <= 1000)) return say('Tokens must be 0 to 1000.', 'err');
    var btn = $('iGo'); btn.disabled = true; say('Sending invite…');
    Auth.token().then(function (t) {
      return fetch('/api/admin/invite', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body: JSON.stringify({ email: email, name: name || undefined, tokens: tokens }) });
    }).then(function (r) {
      return r.text().then(function (txt) {
        var j = null; try { j = JSON.parse(txt); } catch (x) { /* not json */ }
        if (!r.ok) throw Object.assign(new Error((j && (ERR[j.error] || j.message || j.error)) || ('Request failed (' + r.status + ')')), { apiDetail: true });
        return j;
      });
    }).then(function () {
      btn.disabled = false; $('fInvite').reset(); $('iTokens').value = '0';
      var done = clear($('invDone')); done.hidden = false; $('fInvite').hidden = true;
      done.appendChild(h('div', { class: 'success', style: 'margin-top:12px' }, [
        h('b', { text: 'Invite sent to ' + email }),
        h('span', { text: 'An account was created' + (name ? ' for ' + name : '') + ' with ' + plural(tokens, 'token') + '. They will get an email with a link to set their password.' }),
        h('div', { style: 'margin-top:6px' }, [h('button', { type: 'button', class: 'pri', text: 'Invite another', onclick: function () { done.hidden = true; $('fInvite').hidden = false; $('iEmail').focus(); } }),
          ' ', h('button', { type: 'button', text: 'View users', onclick: function () { state.uq = ''; $('uq').value = ''; setView('users'); } })])]));
      say('Invite sent to ' + email + '.', 'ok');
      state.cache = {}; load(true);
    }, function (err) { btn.disabled = false; say(err.message, 'err'); });
  }

  // ================================================================ views & init
  function renderView() {
    var v = state.view;
    if (v === 'overview') renderOverview(); else if (v === 'users') renderUsers(); else if (v === 'calcs') renderLog();
  }
  function renderAll() { renderView(); }
  function setView(name) {
    if (VIEWS.indexOf(name) < 0) name = 'overview';
    state.view = name; savePrefs();
    VIEWS.forEach(function (v) { $('v-' + v).hidden = v !== name; });
    Array.prototype.forEach.call(document.querySelectorAll('#nav button'), function (b) {
      if (b.getAttribute('data-view') === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    renderView();
    if (name === 'calcs' && L.dirty && state.data) loadLog();
    window.scrollTo(0, 0);
  }
  function syncPeriodUI() {
    $('period').value = state.pkey;
    var c = state.pkey === 'custom'; $('pFrom').hidden = !c; $('pTo').hidden = !c;
    $('pFrom').value = state.pFrom; $('pTo').value = state.pTo;
  }
  function init(r) {
    $('who').textContent = r.profile.name || r.profile.email || '';
    $('app').hidden = false;
    $('signout').onclick = function () { Auth.signOut(); };
    var ps = $('period'); PERIODS.forEach(function (p) { ps.appendChild(h('option', { value: p[0], text: p[1] })); });
    loadPrefs(); syncPeriodUI();
    ps.onchange = function () {
      state.pkey = ps.value;
      if (state.pkey === 'custom' && (!state.pFrom || !state.pTo) && state.range) { state.pFrom = dayKey(state.range.from); state.pTo = dayKey(new Date(state.range.to.getTime() - 1)); }
      syncPeriodUI(); load();
    };
    $('pFrom').onchange = $('pTo').onchange = function () { state.pFrom = $('pFrom').value; state.pTo = $('pTo').value; if (state.pFrom && state.pTo) load(); };
    $('reload').onclick = function () { load(true); };
    Array.prototype.forEach.call(document.querySelectorAll('#nav button'), function (b) { b.onclick = function () { setView(b.getAttribute('data-view')); }; });
    $('uq').oninput = function () { state.uq = this.value; renderUsers(); };
    $('usort').onchange = function () { state.usort = this.value; renderUsers(); };
    $('lGo').onclick = loadLog;
    ['lFrom', 'lTo'].forEach(function (id) { $(id).addEventListener('change', function () { L.touched = true; }); });
    ['lRoute', 'lReg'].forEach(function (id) { $(id).addEventListener('keydown', function (ev) { if (ev.key === 'Enter') loadLog(); }); });
    $('fInvite').onsubmit = invite;
    var pre = $('iPre');
    [5, 10, 25].forEach(function (n) { pre.appendChild(h('button', { type: 'button', class: 'sm', text: String(n), 'aria-label': n + ' initial tokens', onclick: function () { $('iTokens').value = String(n); } })); });
    $('scrim').onclick = drawerClose;
    $('status').onclick = function () { say(''); };
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && DR.open) { ev.preventDefault(); drawerClose(); } else trapTab(ev); });
    var lastW = window.innerWidth, rt = null;
    window.addEventListener('resize', function () {
      clearTimeout(rt); rt = setTimeout(function () { if (window.innerWidth !== lastW) { lastW = window.innerWidth; flushCharts(document); } }, 150);
    });
    setView(state.view);
    load();
  }

  if (!window.SB_CONFIG || !SB_CONFIG.url || !SB_CONFIG.anonKey) { document.body.textContent = 'Not configured.'; return; }
  Auth.requireAdmin().then(init, function (e) { $('app').hidden = false; say(errMsg(e), 'err'); });
})();
