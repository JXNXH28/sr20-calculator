// Canonical calculation inputs: what is stored on the server for one calculation (1 token) and hashed for de-duplication.
// Only values that change the printed sheets or the shown results; no fetch bookkeeping, edited flags or UI state.
// Classic script (browser global Snapshot) and CommonJS (node test.js). Pure functions.
(function (root) {
'use strict';

// Flight-level defaults and per-point defaults (app.js starts from these).
const DEFAULTS = { reg: '', flight: '', time: '', prep: '', bem: '', bemCg: '', w1: '', w2: '', w3: '', w4: '', bag: 18, fuelTO: 38.5, trim: 'T/O 0', vrbWorst: true, sheetMode: 'lat', nR: 2, R0: '', R1: '' };
const PT_DEFAULTS = { dur: 60, trip: 15, gnd: 30, slope: 0, surf: 'paved', eflaps: '100', ac: false };

const FLIGHT_NUM = ['bem', 'bemCg', 'w1', 'w2', 'w3', 'w4', 'bag', 'fuelTO'];
const FLIGHT_TXT = ['time', 'flight', 'prep', 'trim'];
const PT_NUM = ['elev', 'hdg', 'len', 'slope', 'wdir', 'wspd', 'wgust', 'qnh', 'oat', 'ewt'];
const PT_TXT = ['rwy', 'surf', 'remarks'];

const num = (v) => {
  if (typeof v === 'number') return isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') { const x = parseFloat(v); return isFinite(x) ? x : undefined; }
  return undefined;
};
const txt = (v) => (v === undefined || v === null ? '' : String(v).trim());
const nStops = (s) => Math.max(1, parseInt(s.nR, 10) || 1);
const pointList = (n) => [...Array(Math.max(1, n - 1)).keys()].map((i) => 'L' + i).concat('D');
const pget = (s, p, k) => (s[`${p}.${k}`] !== undefined ? s[`${p}.${k}`] : PT_DEFAULTS[k]);

// Fields that exist per point: [key, kind] with kind n number, t text, b boolean
function pointKeys(p) {
  const isD = p === 'D', i = isD ? -1 : +p.slice(1);
  const ks = PT_NUM.map((k) => [k, 'n']).concat(PT_TXT.map((k) => [k, 't']), [['eflaps', 't']]);
  if (!isD) ks.push(['tow', 'n'], ['dur', 'n'], ['trip', 'n'], ['ac', 'b']);
  if (!isD && i > 0) ks.push(['gnd', 'n'], ['refuel', 'n']);
  return ks;
}

// Where the weather came from, short: the "wind:" and "temp/QNH:" lines of the fetch info.
const SRC_RE = /^(wind|temp\/QNH): /;
function source(info) {
  const out = info && Array.isArray(info.out) ? info.out : [];
  return out.filter((x) => typeof x === 'string' && SRC_RE.test(x)).join(' | ');
}
// "METAR 1453Z" for display (wind source without its prefix), '' when the values were entered by hand
function sourceLabel(src) {
  const first = String(src || '').split(' | ').find((x) => /^wind: /.test(x));
  return first ? first.replace(/^wind: /, '') : '';
}

function canonical(s) {
  const o = {};
  const put = (k, v) => { if (v !== undefined && v !== '') o[k] = v; };
  put('date', /^\d{4}-\d\d-\d\d$/.test(txt(s.date)) ? txt(s.date) : undefined);
  FLIGHT_TXT.forEach((k) => put(k, txt(s[k])));
  put('reg', txt(s.reg).toUpperCase());
  FLIGHT_NUM.forEach((k) => put(k, num(s[k])));
  o.vrbWorst = s.vrbWorst === undefined ? DEFAULTS.vrbWorst : !!s.vrbWorst;
  if (s.sheetMode === 'pair') o.sheetMode = 'pair'; // only the non-default value is stored, so older snapshots keep their hash
  const n = nStops(s);
  o.nR = n;
  for (let i = 0; i < n; i++) put('R' + i, txt(s['R' + i]).toUpperCase());
  pointList(n).forEach((p) => {
    pointKeys(p).forEach(([k, kind]) => {
      const v = pget(s, p, k);
      if (kind === 'n') put(`${p}.${k}`, num(v));
      else if (kind === 'b') { if (v) o[`${p}.${k}`] = true; }
      else put(`${p}.${k}`, k === 'rwy' ? txt(v).toUpperCase() : txt(v));
    });
    put(`${p}.src`, source(s[`${p}.info`]));
  });
  return o;
}

function meta(s) {
  const n = nStops(s), stops = [];
  for (let i = 0; i < n; i++) { const c = txt(s['R' + i]).toUpperCase(); if (c) stops.push(c); }
  const d = txt(s.date), t = txt(s.time);
  return { flight_date: /^\d{4}-\d\d-\d\d$/.test(d) ? d : null, dep_time: /^\d{1,2}:\d\d$/.test(t) ? t : null, route: stops.join('-'), reg: txt(s.reg).toUpperCase() };
}

// Key-sorted copy, so JSON.stringify is order independent (what the server's jsonb hash does too).
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.keys(v).sort().reduce((a, k) => { a[k] = sortKeys(v[k]); return a; }, {});
  return v;
}
const fingerprint = (s) => JSON.stringify(sortKeys(canonical(s)));

// Inverse of canonical(): an app state (flat map) holding exactly these values. Values absent from the snapshot were
// empty, so fields that have a default are set to "" (not left undefined, which would bring the default back).
function fromCanonical(c) {
  const s = {};
  Object.keys(DEFAULTS).forEach((k) => { s[k] = c[k] !== undefined ? c[k] : DEFAULTS[k] === true ? false : ''; });
  s.vrbWorst = c.vrbWorst !== undefined ? !!c.vrbWorst : DEFAULTS.vrbWorst;
  s.sheetMode = c.sheetMode === 'pair' ? 'pair' : 'lat';
  s.date = c.date || '';
  const n = nStops(c);
  s.nR = n;
  for (let i = 0; i < n; i++) s['R' + i] = c['R' + i] || '';
  pointList(n).forEach((p) => {
    pointKeys(p).forEach(([k]) => {
      const v = c[`${p}.${k}`];
      if (v !== undefined) s[`${p}.${k}`] = v;
      else if (PT_DEFAULTS[k] !== undefined) s[`${p}.${k}`] = k === 'ac' ? false : '';
    });
    const src = c[`${p}.src`];
    if (src) s[`${p}.info`] = { out: String(src).split(' | '), warn: [], err: '' };
  });
  return s;
}

const Snapshot = { DEFAULTS, PT_DEFAULTS, canonical, meta, sortKeys, fingerprint, fromCanonical, source, sourceLabel, pointList, nStops };
if (typeof module !== 'undefined' && module.exports) module.exports = Snapshot; else root.Snapshot = Snapshot;
})(this);
