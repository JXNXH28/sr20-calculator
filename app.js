(function () {
'use strict';
const P = window.Perf;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- input definitions ---------- */
// [key, label, type, extra]  types: t text, n number, c checkbox, s select, a textarea
// Simple form: only what the pilot normally types. Everything else autofills or sits under "details".
const SIMPLE = [
  ['date', 'Date', 'd'], ['reg', 'A/C registration', 't'],
  ['a.apt', 'From (ICAO)', 't'], ['a.time', 'Departure time (local)', 'h'],
  ['a.l_apt', 'To (ICAO)', 't'], ['dur', 'Flight time (min)', 'n'],
  ['w1', 'Seat 1 / pilot (lb)', 'n'], ['w2', 'Seat 2 (lb)', 'n'], ['w3', 'Seat 3 (lb)', 'n'], ['w4', 'Seat 4 (lb)', 'n'],
  ['qfuel', '', 'q'], ['fuelTO', 'Take-off fuel (USG)', 'n'], ['fuelTrip', 'Trip fuel (USG)', 'n'],
  ['bem', 'Basic empty mass (lb)', 'n'], ['bemCg', 'BEM CG (in)', 'n'],
  ['go', '', 'g']
];
const GENERAL = [['flight', 'Flight', 't'], ['prep', 'Prepared by', 't'], ['bag', 'Baggage (lb)', 'n'], ['vrbWorst', 'Variable wind: assume worst case (full tailwind + crosswind)', 'c']];
const SURF = [['paved', 'Paved'], ['dry', 'Dry grass'], ['wet', 'Wet grass']];
const TOF = [
  ['apt', 'Airport (ICAO)', 't'], ['time', 'Local time (HH:MM)', 'h'], ['fetch', '', 'f'], ['elev', 'Elevation (ft)', 'n'], ['rwy', 'Runway', 't'], ['hdg', 'Runway heading (°)', 'n'],
  ['len', 'Runway length (ft)', 'n'], ['slope', 'Slope % (+up / −down)', 'n'], ['surf', 'Surface', 's', SURF],
  ['wdir', 'Wind dir (°)', 'n'], ['wspd', 'Wind speed (kt)', 'n'], ['wgust', 'Gust (kt)', 'n'],
  ['qnh', 'QNH (inHg or hPa)', 'n'], ['oat', 'OAT (°C)', 'n'], ['ac', 'Air conditioning ON', 'c'],
  ['trim', 'Trim', 't'], ['tow', 'T.O.W. override (lb)', 'n'], ['remarks', 'ATIS / remarks', 'a']
];
const LDF = [
  ['l_apt', 'Destination (ICAO)', 't'], ['l_time', 'Local time (HH:MM)', 'h'], ['l_fetch', '', 'f'], ['l_elev', 'Elevation (ft)', 'n'], ['l_rwy', 'Runway', 't'], ['l_hdg', 'Runway heading (°)', 'n'],
  ['l_len', 'Runway length (ft)', 'n'], ['l_slope', 'Slope % (+up / −down)', 'n'], ['l_surf', 'Surface', 's', SURF],
  ['l_wdir', 'Wind dir (°)', 'n'], ['l_wspd', 'Wind speed (kt)', 'n'], ['l_wgust', 'Gust (kt)', 'n'],
  ['l_qnh', 'QNH (inHg or hPa)', 'n'], ['l_oat', 'OAT (°C)', 'n'],
  ['l_flaps', 'Landing flaps', 's', [['100', '100 %'], ['50', '50 %'], ['0', '0 %']]], ['ldw', 'Landing mass override (lb)', 'n']
];

const SIMPLE_KEYS = new Set(['apt', 'time', 'fetch', 'l_apt', 'l_fetch']);
const detail = (defs) => defs.filter(([k]) => !SIMPLE_KEYS.has(k));
const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const DEFAULTS = {
  date: today, reg: '', flight: '', prep: '', bem: 2260, bemCg: 140.7, w1: 190, w2: 170, w3: 0, w4: 0, bag: 18, vrbWorst: true, fuelTO: 38.5, fuelTrip: 20, dur: 60,
  'a.on': true, 'b.on': false
};
['a', 'b'].forEach((p) => {
  Object.assign(DEFAULTS, {
    [p + '.apt']: '', [p + '.elev']: '', [p + '.rwy']: '', [p + '.hdg']: '', [p + '.len']: '', [p + '.slope']: 0, [p + '.surf']: 'paved',
    [p + '.wdir']: '', [p + '.wspd']: '', [p + '.wgust']: '', [p + '.qnh']: 29.92, [p + '.oat']: 15, [p + '.ac']: false,
    [p + '.trim']: 'T/O', [p + '.tow']: '', [p + '.remarks']: '',
    [p + '.l_apt']: '', [p + '.time']: '', [p + '.l_time']: '', [p + '.l_rwy']: '', [p + '.l_elev']: '', [p + '.l_hdg']: '', [p + '.l_len']: '', [p + '.l_slope']: 0, [p + '.l_surf']: 'paved',
    [p + '.l_wdir']: '', [p + '.l_wspd']: '', [p + '.l_wgust']: '', [p + '.l_qnh']: 29.92, [p + '.l_oat']: 15, [p + '.l_flaps']: '100', [p + '.ldw']: ''
  });
});

/* ---------- build input panel ---------- */
function fieldHTML(id, label, type, opts) {
  if (type === 'f') return `<div class="wide fetch" data-p="${id.split('.')[0]}." data-land="${id.includes('l_') ? 1 : 0}"><button type="button" class="fbtn">Fetch airport &amp; weather</button><select class="rsel" hidden></select><div class="fstat"></div></div>`;
  if (type === 'g') return '<div class="wide fetchall"><button type="button" class="gobtn">Fetch airports &amp; weather</button><div class="fetch" data-p="a." data-land="0"><span class="rl">Departure runway</span><select class="rsel" hidden></select><div class="fstat"></div></div><div class="fetch" data-p="a." data-land="1"><span class="rl">Landing runway</span><select class="rsel" hidden></select><div class="fstat"></div></div></div>';
  if (type === 'q') return '<div class="wide quick"><span>Take-off fuel (after 1.5 USG taxi):</span><button type="button" data-fuel="54.5">56 USG → 54.5</button><button type="button" data-fuel="38.5">40 USG → 38.5</button></div>';
  if (type === 'c') return `<label class="chk wide"><input type="checkbox" id="${id}" data-k="${id}"> ${label}</label>`;
  let ctl;
  if (type === 's') ctl = `<select id="${id}" data-k="${id}">${opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select>`;
  else if (type === 'a') ctl = `<textarea id="${id}" data-k="${id}" rows="2"></textarea>`;
  else ctl = `<input id="${id}" data-k="${id}" type="${type === 'n' ? 'number' : type === 'd' ? 'date' : type === 'h' ? 'time' : 'text'}" ${type === 'n' ? 'step="any"' : ''}>`;
  return `<label class="${type === 'a' ? 'wide' : ''}"><span>${label}</span>${ctl}</label>`;
}
const grid = (id, defs, prefix = '') => defs.map(([k, l, t, o]) => fieldHTML(prefix + k, l, t, o)).join('');
function section(title, body, open) { return `<details ${open ? 'open' : ''}><summary>${title}</summary><div class="fg">${body}</div></details>`; }
$('#inputs').innerHTML =
  section('Flight', grid('s', SIMPLE), true) +
  section('Details – flight & baggage', grid('g', GENERAL)) +
  section('Details – sheet 1 takeoff', grid('a', detail(TOF), 'a.')) +
  section('Details – sheet 1 landing', grid('a', detail(LDF), 'a.')) +
  section('Sheet 2 – takeoff (optional)', fieldHTML('b.on', 'Fill in second T/O data sheet', 'c') + grid('b', TOF, 'b.')) +
  section('Sheet 2 – landing', grid('b', LDF, 'b.'));

// Weather/airport autofill needs the local relay (node server.js). Elsewhere (e.g. GitHub Pages) hide it
// and show the manual inputs instead.
if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname) || /[?&]noserver/.test(location.search)) { // ?noserver previews the hosted view
  document.body.classList.add('noserver');
  ['a.time', 'dur', 'a.l_time', 'b.time', 'b.l_time'].forEach((id) => { const e = document.getElementById(id); if (e) e.closest('label').classList.add('wx'); });
  document.querySelectorAll('#inputs details').forEach((d, i) => {
    if (i >= 1 && i <= 3) d.open = true;
    const s = d.querySelector('summary'); const t = s.textContent.replace('Details – ', ''); s.textContent = t[0].toUpperCase() + t.slice(1);
  });
}

/* ---------- state ---------- */
const KEY = 'sr20calc.v1', BEMKEY = 'sr20calc.bem';
const els = [...document.querySelectorAll('[data-k]')];
function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } }
function setAll(vals) {
  els.forEach((el) => {
    const v = vals[el.dataset.k];
    if (v === undefined) return;
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
  });
}
function readAll() {
  const s = {};
  els.forEach((el) => { s[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value; });
  return s;
}
const num = (v) => (v === '' || v === undefined || v === null ? NaN : parseFloat(v));
const fin = P.isNum;
setAll(Object.assign({}, DEFAULTS, lsGet(KEY) || {}));

/* ---------- formatting ---------- */
const r0 = (v) => (fin(v) ? String(Math.round(v)) : '');
const r10 = (v) => (fin(v) ? String(Math.ceil(v / 10 - 1e-9) * 10) : '');
const r1 = (v) => (fin(v) ? v.toFixed(1) : '');
const pad = (s) => (s === '' ? '&nbsp;' : s);
const isCalm = (d, s) => (!fin(d) && !fin(s)) || s === 0; // nothing entered, or 0 kt
function windStr(d, s, g) {
  if (isCalm(d, s)) return 'CALM';
  if (!fin(d) && fin(s)) return `VRB/${Math.round(s)}`;
  return `${fin(d) ? String(Math.round(d)).padStart(3, '0') : '---'}/${fin(s) ? Math.round(s) : '--'}${fin(g) && g > s ? 'G' + Math.round(g) : ''}`;
}
function qnhStr(q) { return fin(q) ? (q > 80 ? String(Math.round(q)) : q.toFixed(2)) : ''; }
const side = (v) => (v >= 0 ? 'R' : 'L');

/* ---------- main render ---------- */
function legData(s, p, L) {
  const g = (k) => s[p + '.' + k];
  const n = (k) => num(g(k));
  const oat = n('oat'), qnh = n('qnh');
  const tow = fin(n('tow')) ? n('tow') : L.tom;
  const common = { vrbWorst: s.vrbWorst, elev: n('elev'), qnh, oat, wdir: n('wdir'), wspd: n('wspd'), wgust: n('wgust'), hdg: n('hdg'), len: n('len'), slope: n('slope'), surf: g('surf') };
  const t = P.takeoff(Object.assign({ tow, ac: g('ac') }, common));
  const ldw = fin(n('ldw')) ? n('ldw') : L.lm;
  const flaps = parseInt(g('l_flaps'), 10);
  const l = P.landing({ vrbWorst: s.vrbWorst, elev: n('l_elev'), qnh: n('l_qnh'), oat: n('l_oat'), wdir: n('l_wdir'), wspd: n('l_wspd'), wgust: n('l_wgust'), hdg: n('l_hdg'), len: n('l_len'), slope: n('l_slope'), surf: g('l_surf'), flaps, w: ldw });
  return {
    t, l, ldw, lflaps: flaps, llen: n('l_len'), lapt: [g('l_apt').trim(), g('l_rwy').trim()].filter(Boolean).join(' '),
    dateac: [fmtDate(s.date), s.reg].filter(Boolean).join(' / '), apt: g('apt'), elev: g('elev') === '' ? '' : Math.round(n('elev')) + ' ft', rwy: g('rwy'),
    len: g('len') === '' ? '' : Math.round(n('len')) + ' ft', lenN: n('len'), tow, trim: g('trim'), remarks: g('remarks'),
    wdir: n('wdir'), wspd: n('wspd'), wgust: n('wgust'), qnh, oat
  };
}

/* ---------- PDF filling (draws onto the original LAT form) ---------- */
const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
const INK = rgb(0.04, 0.2, 0.58), RED = rgb(0.8, 0, 0);
const clean = (t) => String(t).replace(/[^\x20-\xFF]/g, '?');

function put(c, text, x, y, o = {}) {
  text = clean(text);
  if (!text.trim()) return;
  const font = o.bold === false ? c.font : c.bold;
  let size = o.size || 10;
  if (o.maxW) while (size > 5 && font.widthOfTextAtSize(text, size) > o.maxW) size -= 0.25;
  c.page.drawText(text, { x, y, size, font, color: o.color || INK });
}
const wrap = (font, text, size, maxW) => {
  const lines = [];
  String(text).split('\n').forEach((para) => {
    let line = '';
    para.split(/\s+/).forEach((w) => {
      const t = line ? line + ' ' + w : w;
      if (font.widthOfTextAtSize(clean(t), size) <= maxW || !line) line = t; else { lines.push(line); line = w; }
    });
    lines.push(line);
  });
  return lines;
};

// T/O data sheet: label coordinates come from the form; value goes just below each label.
const DY2 = -278.2; // second box offset
function drawSheet(c, dy, S, occ) {
  const v = (text, x, ly, o) => put(c, text, x, ly - 14 + dy, Object.assign({ size: 10, maxW: 66 }, o));
  const C1 = 169.2, C2 = 241.2, C3 = 313.2, C4 = 385.3;
  const bad = (a, b) => (fin(a) && fin(b) && a > b ? { color: RED } : {});
  const t = S.t, l = S.l;
  v(S.dateac, C1, 646.3, { size: 8.5 });
  v(S.apt, C1, 622.5); v(S.elev, C1, 598.9); v(S.rwy, C1, 575.1); v(S.len, C1, 551.4);
  v(r0(S.tow), C2, 646.3); v(S.trim, C2, 598.9); v(r0(t.vr), C2, 575.1); v(r0(t.vlof), C2, 551.4);
  if (occ >= 1 && occ <= 4) {
    const cx = 259.4 + 7.2 * (occ - 1) + 1.7, cy = 606.5 + dy + 2.1;
    c.page.drawEllipse({ x: cx, y: cy, xScale: 4.8, yScale: 4.8, borderColor: INK, borderWidth: 0.9 });
  }
  v(r10(t.tor), C3, 646.3, bad(t.tor, S.lenN)); v(r10(t.tod), C3, 620.3, bad(t.tod, S.lenN)); v(r0(t.roc), C3, 559.1);
  v(windStr(S.wdir, S.wspd, S.wgust), C1, 526.0);
  if (isCalm(S.wdir, S.wspd)) {
    v('0 / 0°', C1, 502.3); v('HW 0', C1, 478.6);
  } else if (t.wind) {
    const sd = (x) => (t.wind.vrb ? '' : side(x)); // variable wind has no side
    v(`${r0(Math.abs(t.cross))}${sd(t.cross)} / ${fin(t.wca) ? r0(Math.abs(t.wca)) + '°' + sd(t.wca) : ''}`, C1, 502.3);
    v(t.head >= 0 ? `HW ${r0(t.head)}` : `TW ${r0(-t.head)}`, C1, 478.6, t.head < 0 ? { color: RED } : {});
  }
  v(qnhStr(S.qnh), C2, 526.0); v(r0(t.pa), C2, 502.3); v(fin(t.ff) ? r1(t.ff) : '', C2, 478.6);
  v(fin(S.oat) ? String(S.oat) : '', C3, 525.1);
  v(fin(t.da) ? r0(Math.round(t.da / 10) * 10) : '', C3, 488.5);
  // ATIS / remarks
  if (S.remarks) {
    wrap(c.bold, S.remarks, 8, 118).slice(0, 10).forEach((ln, i) => put(c, ln, 387.5, 628 + dy - i * 10, { size: 8 }));
  }
  // landing data
  if (fin(S.ldw)) {
    const w = `${r0(S.ldw)} / ${r0(l.vref)} / ${r0(l.vtgt)}`;
    put(c, w, C4, 502.3 - 14 + dy, { size: 10, maxW: 90 });
    put(c, 'F' + S.lflaps, C4 + 96, 502.3 - 14 + dy, { size: 7 });
  }
  if (fin(l.tot)) {
    put(c, `${S.lapt ? S.lapt + '  ' : ''}${r0(S.llen)} / ${r10(l.tot)}`, C4, 478.6 - 14 + dy, Object.assign({ size: 10, maxW: 118 }, bad(l.tot, S.llen)));
  }
}

// Load sheet: calibrated on the image placed on page 2 (523x797 px at 74.075/42.339, 463.85 pt wide).
const PS = 463.85 / 523;
const gx = (px) => 74.075 + px * PS;
const gy = (py) => 42.339 + (797 - py) * PS;
const MX = (m) => 193.5 + (m - 300) * 1.7412;     // moment axis (px)
const MY = (lb) => 461.0 + (3200 - lb) * 0.227;   // mass axis (px)
const ROWTOP = (i) => 176.2 + 28.5 * i, ROWC = (i) => ROWTOP(i) + 14.25;
const GREY = new Set([3, 6, 8]); // rows with a printed max-box at the bottom
const DIGX = [143.8, 158.0, 172.2, 186.4];

function drawLoad(c, s, L) {
  const P2 = (text, px, py, o) => put(c, text, gx(px), gy(py), o);
  P2(s.reg, 150, 88, { size: 11, maxW: 80 }); P2(s.flight, 150, 112, { size: 11, maxW: 80 });
  P2(fmtDate(s.date), 150, 137, { size: 11, maxW: 80 });
  P2(s.prep, 58, 726, { size: 9, maxW: 120 });
  if (L && L.m && fin(L.m.bem)) P2(L.m.bem.toFixed(1), 323, 181, { size: 9, maxW: 42 });
  // cross out occupied seats on the cabin sketch (image px boxes)
  [[1, 355.5, 121.8, 391.3, 148.8], [2, 355.5, 84.5, 391.3, 111.8], [3, 407, 117, 442.5, 146.2], [4, 407, 87.5, 442.5, 117]].forEach(([n, x0, y0, x1, y1]) => {
    if (!(num(s['w' + n]) > 0)) return;
    const seg = (a, b, c2, d) => c.page.drawLine({ start: { x: gx(a), y: gy(b) }, end: { x: gx(c2), y: gy(d) }, thickness: 1.3, color: INK });
    seg(x0 + 2, y0 + 2, x1 - 2, y1 - 2); seg(x0 + 2, y1 - 2, x1 - 2, y0 + 2);
  });
  if (!L || !fin(L.zfm)) return;
  const w = L.w;
  const wts = [w.bem, w.s12, w.s34, w.bag, L.zfm, w.fuelTO, L.tom, w.trip, L.lm];
  wts.forEach((v, i) => {
    if (!fin(v)) return;
    const d = String(Math.round(v)).padStart(4, ' ');
    [...d].forEach((ch, k) => { if (ch !== ' ') c.page.drawText(ch, { x: gx(DIGX[k]) - c.bold.widthOfTextAtSize(ch, GREY.has(i) ? 9.5 : 11) / 2, y: gy(ROWTOP(i) + (GREY.has(i) ? 14.5 : 18.5)), size: GREY.has(i) ? 9.5 : 11, font: c.bold, color: INK }); });
  });
  if (!L.cum) return;
  const cm = L.cum, X = [cm.bem, cm.s12, cm.s34, cm.bag, cm.fuel, cm.lm].map(MX);
  const [x0, x1, x2, x3, x4, x5] = X;
  const cy = (i) => ROWC(i);
  // trim line: straight down, then along the row to the left/right, never diagonal
  const path = [[x0, 202], [x0, cy(1)], [x1, cy(1)], [x1, cy(2)], [x2, cy(2)], [x2, cy(3)], [x3, cy(3)], [x3, cy(5)], [x4, cy(5)], [x4, cy(7)], [x5, cy(7)], [x5, cy(8)]];
  const seg = (a, b, th = 1.1) => c.page.drawLine({ start: { x: gx(a[0]), y: gy(a[1]) }, end: { x: gx(b[0]), y: gy(b[1]) }, thickness: th, color: INK });
  for (let i = 1; i < path.length; i++) seg(path[i - 1], path[i]);
  const dot = (px, py, r, col = INK) => c.page.drawCircle({ x: gx(px), y: gy(py), size: r, color: col });
  dot(x0, 202, 1.8);
  [[x0, cy(0)], [x1, cy(1)], [x2, cy(2)], [x3, cy(3)], [x3, cy(4)], [x4, cy(5)], [x4, cy(6)], [x5, cy(7)], [x5, cy(8)]].forEach(([a, b]) => dot(a, b, 1.3));
  // drops into the envelope: down from ZFM / TOM / LM, across from the mass axis
  [['ZFM', x3, 4, L.zfm], ['TOM', x4, 6, L.tom], ['LM', x5, 8, L.lm]].forEach(([name, x, row, lb]) => {
    const y = MY(lb), ok = L.inside[name.toLowerCase()], col = ok ? INK : RED;
    seg([x, cy(row)], [x, y], 0.9);
    c.page.drawLine({ start: { x: gx(MX(300)), y: gy(y) }, end: { x: gx(x), y: gy(y) }, thickness: 0.5, color: INK, dashArray: [2, 2] });
    dot(x, y, 2.4, col);
    put(c, name, gx(x) + 4, gy(y) + 2.5, { size: 7, color: col });
  });
}
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
function fmtDate(d) { // 2026-11-11 -> "11 NOV 26"
  const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(d || '');
  return m ? `${m[3]} ${MON[+m[2] - 1]} ${m[1].slice(2)}` : d || '';
}

async function buildPdf(s, L, sheets, occ) {
  const bin = atob(window.FORM_PDF_B64);
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  const doc = await PDFDocument.load(bytes);
  const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const [p1, p2] = doc.getPages();
  sheets.forEach((S, i) => drawSheet({ page: p1, font, bold }, i ? DY2 : 0, S, occ));
  drawLoad({ page: p2, font, bold }, s, L);
  return doc.save();
}

/* ---------- render + preview ---------- */
const pdfjs = window.pdfjsLib;
pdfjs.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
let lastBytes = null, seq = 0, timer = null;

async function preview(bytes) {
  const my = ++seq;
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const host = $('#pages');
  const w = Math.min(host.clientWidth - 8, 820), dpr = window.devicePixelRatio || 1;
  const canvases = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const pg = await doc.getPage(n);
    const base = pg.getViewport({ scale: 1 });
    const vp = pg.getViewport({ scale: (w / base.width) * dpr });
    const cv = document.createElement('canvas');
    cv.width = vp.width; cv.height = vp.height; cv.style.width = w + 'px'; cv.style.height = (vp.height / dpr) + 'px';
    await pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
    canvases.push(cv);
  }
  if (my !== seq) return;
  host.replaceChildren(...canvases);
}

function update() {
  const s = readAll();
  const keep = Object.assign({}, s);
  ['date', 'a.time', 'a.l_time', 'b.time', 'b.l_time'].forEach((k) => delete keep[k]); // never carry yesterday's date/times over
  lsSet(KEY, keep);
  const L = P.loadSheet({ bem: num(s.bem), bemMom: num(s.bem) * num(s.bemCg) / 1000, w1: num(s.w1), w2: num(s.w2), w3: num(s.w3), w4: num(s.w4), bag: num(s.bag), fuelTO: num(s.fuelTO), fuelTrip: num(s.fuelTrip) });
  const occ = [s.w1, s.w2, s.w3, s.w4].filter((v) => num(v) > 0).length;
  const sheets = [legData(s, 'a', L)];
  if (s['b.on']) sheets.push(legData(s, 'b', L));
  const warns = [];
  if (!fin(num(s.bem)) || !fin(num(s.bemCg))) warns.push('Enter basic empty mass and CG from the aircraft weight report.');
  L.warn.forEach((x) => warns.push(x));
  sheets.forEach((S, i) => [...S.t.warn, ...S.l.warn].forEach((x) => warns.push(`Sheet ${i + 1}: ${x}`)));
  $('#warn').innerHTML = warns.length ? '<b>Check:</b><ul>' + warns.map((x) => `<li>${esc(x)}</li>`).join('') + '</ul>' : '<span class="ok">All values within limits.</span>';
  $('#sum').textContent = fin(L.tom) ? `ZFM ${Math.round(L.zfm)} lb · TOM ${Math.round(L.tom)} lb · LM ${Math.round(L.lm)} lb` : '';
  buildPdf(s, L, sheets, occ).then((b) => { lastBytes = b; return preview(b); }).catch((e) => { console.error(e); $('#warn').innerHTML += '<br><b>PDF error:</b> ' + esc(e.message); });
}
const schedule = () => { clearTimeout(timer); timer = setTimeout(update, 120); };

let lastReg = null;
document.addEventListener('input', (e) => {
  const el = e.target;
  if (!el.dataset || !el.dataset.k) return;
  const map = lsGet(BEMKEY) || {};
  if (el.dataset.k === 'reg') {
    const r = el.value.trim().toUpperCase();
    if (r && map[r] && r !== lastReg) { $('#bem').value = map[r].bem; if (map[r].cg !== undefined) $('#bemCg').value = map[r].cg; }
    lastReg = r;
  } else if (el.dataset.k === 'bem' || el.dataset.k === 'bemCg') {
    const r = $('#reg').value.trim().toUpperCase();
    if (r) { map[r] = { bem: $('#bem').value, cg: $('#bemCg').value }; lsSet(BEMKEY, map); }
  }
  schedule();
});
window.addEventListener('resize', schedule);
function blobUrl() { return URL.createObjectURL(new Blob([lastBytes], { type: 'application/pdf' })); }
$('#download').addEventListener('click', () => {
  if (!lastBytes) return;
  const a = document.createElement('a');
  a.href = blobUrl();
  a.download = `SR20_TO_LoadSheet_${($('#reg').value || 'flight').replace(/\W+/g, '')}_${$('#date').value || ''}.pdf`;
  a.click();
});
$('#print').addEventListener('click', () => { if (lastBytes) window.open(blobUrl(), '_blank'); });
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-fuel]');
  if (!b) return;
  const f = $('#fuelTO'); f.value = b.dataset.fuel; f.dispatchEvent(new Event('input', { bubbles: true }));
});
$('#reset').addEventListener('click', () => { setAll(DEFAULTS); update(); });
update();
})();
