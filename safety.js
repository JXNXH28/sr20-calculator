// OFP safety layer: winds-aloft parsing and interpolation, altitude profile, airspace conflicts, glide reach,
// terrain/obstacle maxima, the warn/info checks and the altitude recommender. Pure functions, no network.
// Classic script (works from file://) and CommonJS (node test.js). Needs Nav (nav.js).
// Units: NM, ft MSL, headings in degrees. Every result built from automatic data is "verify on chart".
(function (root) {
'use strict';

const Nav = (typeof module !== 'undefined' && module.exports && typeof require === 'function') ? require('./nav.js') : root.Nav;

const isNum = (v) => typeof v === 'number' && isFinite(v);
const round1 = (x) => Math.round(x * 10 + 1e-9) / 10;
const RAD = Math.PI / 180, DEG = 180 / Math.PI;
const FT_PER_M = 3.28084;
const UNLIMITED = 99999;

/* ---------------- winds aloft ---------------- */
// Wind at an altitude. `levels` is {altFt: {dir, spd, temp}} or [{alt, dir, spd, temp}] (model levels).
// Wind is interpolated as a vector (so 350 and 010 average to 360, not 180). Outside the range it holds the nearest level.
// Temperature falls 2 C per 1000 ft where a level has none. Returns null for empty input.
function interpWind(levels, altFt) {
  const arr = (Array.isArray(levels) ? levels.map((l) => ({ alt: l.alt, dir: l.dir, spd: l.spd, temp: l.temp }))
    : Object.keys(levels || {}).map((k) => ({ alt: +k, dir: levels[k].dir, spd: levels[k].spd, temp: levels[k].temp })))
    .filter((l) => isNum(l.alt) && isNum(l.dir) && isNum(l.spd)).sort((a, b) => a.alt - b.alt);
  if (!arr.length) return null;
  const uv = (l) => ({ u: -l.spd * Math.sin(l.dir * RAD), v: -l.spd * Math.cos(l.dir * RAD) }); // wind FROM dir -> motion vector
  let lo = arr[0], hi = arr[0];
  if (altFt >= arr[arr.length - 1].alt) { lo = hi = arr[arr.length - 1]; }
  else if (altFt > arr[0].alt) {
    for (let i = 0; i < arr.length - 1; i++) if (altFt >= arr[i].alt && altFt <= arr[i + 1].alt) { lo = arr[i]; hi = arr[i + 1]; break; }
  }
  const f = hi.alt === lo.alt ? 0 : (altFt - lo.alt) / (hi.alt - lo.alt);
  const a = uv(lo), b = uv(hi);
  const u = a.u + (b.u - a.u) * f, v = a.v + (b.v - a.v) * f;
  const spd = Math.sqrt(u * u + v * v);
  const dir = spd < 0.5 ? 0 : Nav.norm360(Math.atan2(-u, -v) * DEG);
  // temperature: interpolate between levels that have one, otherwise lapse from the nearest
  const withT = arr.filter((l) => isNum(l.temp));
  let temp = null;
  if (withT.length) {
    let tl = withT[0], th = withT[0];
    if (altFt >= withT[withT.length - 1].alt) tl = th = withT[withT.length - 1];
    else if (altFt > withT[0].alt) for (let i = 0; i < withT.length - 1; i++) if (altFt >= withT[i].alt && altFt <= withT[i + 1].alt) { tl = withT[i]; th = withT[i + 1]; break; }
    if (tl === th) temp = tl.temp - 2 * (altFt - tl.alt) / 1000;
    else temp = tl.temp + (th.temp - tl.temp) * (altFt - tl.alt) / (th.alt - tl.alt);
    temp = Math.round(temp * 10) / 10;
  }
  return { dir: Math.round(dir) || (spd >= 0.5 ? 360 : 0), spd: Math.round(spd), temp };
}

/* ---------------- altitude profile of a leg ----------------
 * rows: [{dist, alt, prevAlt, last?}] (the computeOfp rows work as they are; `last` defaults to the final row).
 * Returns, per row, a list of segments {distFrom, distTo, altFrom, altTo} in NM from the START of that leg:
 *  - climb (alt > prevAlt) at the START of the leg, 500 fpm at 105 kt (Nav.tocNm), cut off at the leg length;
 *  - descent (alt < prevAlt): on the LAST leg it starts Nav.todNm before the end (the destination TPA is reached over
 *    the airport); on other legs it starts at the beginning of the leg (descend promptly after the checkpoint);
 *  - the rest is level at `alt`.
 * Where the climb or descent does not finish inside the leg, the segment ends at the interpolated altitude. */
function legProfile(rows) {
  return (rows || []).map((r, i, all) => {
    const d = Math.max(0, +r.dist || 0), alt = r.alt;
    const from = isNum(r.prevAlt) ? r.prevAlt : alt;
    const last = r.last !== undefined ? !!r.last : i === all.length - 1;
    const segs = [];
    const push = (f, t, af, at) => { if (t - f > 1e-9 || (d === 0 && !segs.length)) segs.push({ distFrom: f, distTo: t, altFrom: af, altTo: at }); };
    if (d === 0) { push(0, 0, from, alt); return segs; }
    if (alt > from) {
      const toc = Math.min(d, Nav.tocNm(from, alt));
      const reach = toc >= Nav.tocNm(from, alt) - 1e-9 ? alt : from + (alt - from) * (toc / Nav.tocNm(from, alt));
      push(0, toc, from, reach); push(toc, d, reach, reach);
    } else if (alt < from) {
      const dd = Nav.todNm(from, alt);
      if (last) {
        const s = Math.max(0, d - dd);
        push(0, s, from, from); push(s, d, from, alt); // a last leg shorter than TOD descends steeper
      } else {
        const e = Math.min(d, dd);
        const reach = dd <= d + 1e-9 ? alt : from + (alt - from) * (e / dd);
        push(0, e, from, reach); push(e, d, reach, reach);
      }
    } else push(0, d, alt, alt);
    return segs;
  });
}
function altAt(segs, nm) {
  if (!segs || !segs.length) return null;
  for (const s of segs) {
    if (nm >= s.distFrom - 1e-9 && nm <= s.distTo + 1e-9) {
      const span = s.distTo - s.distFrom;
      return span < 1e-9 ? s.altTo : s.altFrom + (s.altTo - s.altFrom) * (nm - s.distFrom) / span;
    }
  }
  return nm < segs[0].distFrom ? segs[0].altFrom : segs[segs.length - 1].altTo;
}

/* ---------------- airspace ---------------- */
// ring = [[lat, lon], ...]; ray casting
function pointInPolygon(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][0], xi = ring[i][1], yj = ring[j][0], xj = ring[j][1];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// Airspace records are {name, cls, lowerFt, upperFt, lowerRef:'MSL'|'SFC', rings:[[[lat,lon],...]], hours?}.
// lowerRef 'SFC' with lowerFt 0 is the surface; with lowerFt > 0 it is AGL (class E5/E6 700/1200 AGL, SUA "500 AGL").
// `opts.groundFt` (default 0, the cautious choice) turns an AGL floor into MSL. upperFt 99999 = unlimited.
// Classes: B C D, MODEC (Mode C veil), R (restricted), P (prohibited), MOA, ALERT, W (warning), DNGR (danger).
const CONFLICT_CLASSES = { B: 1, C: 1, D: 1, MODEC: 1, R: 1, P: 1, MOA: 1, ALERT: 1, W: 1, DNGR: 1 };
function airspaceConflicts(a, b, profile, airspaces, opts) {
  const ground = (opts && isNum(opts.groundFt)) ? opts.groundFt : 0;
  const step = (opts && opts.stepNm) || 0.25;
  const len = Nav.dist(a, b);
  const n = Math.max(1, Math.ceil(len / step));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const nm = len * i / n, p = len < 1e-9 ? { lat: a.lat, lon: a.lon } : Nav.along(a, b, i / n);
    pts.push({ nm, lat: p.lat, lon: p.lon, alt: altAt(profile, nm) });
  }
  const out = [];
  // opts.airports: [{ident, name, lat, lon}] (departure/destination). A conflict gets `ap` = the ident of an airport whose name
  // is in the airspace name, whose ident is a word in it, or whose position is inside one of its rings.
  const aps = (opts && opts.airports) || [];
  const tagApt = (as) => {
    const nm = String(as.name || '').toUpperCase();
    for (const a of aps) {
      if (a.name && nm.includes(String(a.name).toUpperCase())) return a.ident;
      if (a.ident && new RegExp('\\bK?' + String(a.ident).replace(/^K(?=[A-Z0-9]{3}$)/, '').toUpperCase() + '\\b').test(nm)) return a.ident;
      if (isNum(a.lat) && isNum(a.lon) && as.rings.some((r) => pointInPolygon(a.lat, a.lon, r))) return a.ident;
    }
    return null;
  };
  (airspaces || []).forEach((as) => {
    if (!as || !as.rings || !CONFLICT_CLASSES[as.cls]) return;
    const floor = as.lowerRef === 'SFC' ? (as.lowerFt > 0 ? as.lowerFt + ground : 0) : (as.lowerFt || 0);
    const ceil = isNum(as.upperFt) ? as.upperFt : UNLIMITED;
    // footprint spans: runs of consecutive samples inside any ring
    let run = null; const runs = [];
    pts.forEach((p) => {
      const inFoot = as.rings.some((r) => pointInPolygon(p.lat, p.lon, r));
      if (inFoot) { if (!run) { run = []; runs.push(run); } run.push(p); } else run = null;
    });
    runs.forEach((r) => {
      const inAlt = r.filter((p) => isNum(p.alt) && p.alt >= floor && p.alt <= ceil);
      if (inAlt.length) {
        out.push({ name: as.name, cls: as.cls, lowerFt: as.lowerFt, upperFt: as.upperFt, lowerRef: as.lowerRef, fromNm: round1(inAlt[0].nm), toNm: round1(inAlt[inAlt.length - 1].nm), kind: 'inside', ap: tagApt(as) });
      } else if ((as.cls === 'B' || as.cls === 'C') && floor > 0 && r.every((p) => isNum(p.alt) && p.alt < floor)) {
        out.push({ name: as.name, cls: as.cls, lowerFt: as.lowerFt, upperFt: as.upperFt, lowerRef: as.lowerRef, fromNm: round1(r[0].nm), toNm: round1(r[r.length - 1].nm), kind: 'under-shelf' });
      }
    });
  });
  return out.sort((x, y) => x.fromNm - y.fromNm);
}

// ADDS feature attributes -> altitude in ft. UOM 'FL' = hundreds of feet; value <= -9000 or UNLTD/BYNOTAM = unlimited.
// CODE: 'MSL', 'STD' (flight level, = MSL here), 'SFC' (AGL; 0 = the surface).
// Class_Airspace: UPPER_VAL/LOWER_VAL are numbers; Special_Use_Airspace: the same fields are strings.
// Field names (verified against the live layers): IDENT, NAME, CLASS, LOCAL_TYPE (CLASS_B, MODE C, CLASS_E5...),
// UPPER_VAL/UPPER_UOM/UPPER_CODE, LOWER_VAL/LOWER_UOM/LOWER_CODE; SUA also TYPE_CODE (R, P, MOA, A, W, D) and TIMESOFUSE.
function addsAlt(val, uom, code) {
  const v = typeof val === 'string' ? parseFloat(val) : val;
  if (!isNum(v)) return /UNL|NOTAM/i.test(String(code || val || '')) ? UNLIMITED : null;
  if (v <= -9000 || /UNL|NOTAM/i.test(String(code || ''))) return UNLIMITED;
  return Math.round(/^FL$/i.test(uom || '') ? v * 100 : v);
}
const SUA_CLS = { R: 'R', P: 'P', MOA: 'MOA', A: 'ALERT', W: 'W', D: 'DNGR' };
// feature: ArcGIS JSON {attributes, geometry:{rings:[[[lon,lat],...]]}}; layer: 'class' | 'sua'. Returns null if unusable.
function fromAddsAirspace(f, layer) {
  const a = (f && f.attributes) || {}, g = f && f.geometry;
  if (!g || !g.rings || !g.rings.length) return null;
  let cls;
  if (layer === 'sua') cls = SUA_CLS[String(a.TYPE_CODE || '').toUpperCase()] || null;
  else cls = /MODE/i.test(a.LOCAL_TYPE || a.TYPE_CODE || '') ? 'MODEC' : (a.CLASS || null);
  if (!cls) return null;
  const lower = addsAlt(a.LOWER_VAL, a.LOWER_UOM, a.LOWER_CODE), upper = addsAlt(a.UPPER_VAL, a.UPPER_UOM, a.UPPER_CODE);
  if (lower === null || upper === null) return null;
  const o = { name: String(a.NAME || a.IDENT || cls).replace(/\s+/g, ' ').trim(), cls, lowerFt: lower, upperFt: upper,
    lowerRef: String(a.LOWER_CODE || '').toUpperCase() === 'SFC' ? 'SFC' : 'MSL',
    rings: g.rings.map((r) => r.map((p) => [p[1], p[0]])) };
  if (a.TIMESOFUSE) o.hours = String(a.TIMESOFUSE);
  return o;
}

/* ---------------- glide reach ----------------
 * fields: [{ident, lat, lon, elev, name?}]. altFt: number, or (nmFromStart) => ft. Samples the leg every `step` NM
 * (default 1). A sample is covered when some field is within Nav.glideReachNm(alt, field.elev).
 * fields: each field that is within reach at some sample, with distNm = position along the leg (NM) of its closest sample
 * and offNm = its distance from that sample. gaps: runs of samples with no field in reach, as {fromNm, toNm}. */
function glide(a, b, altFt, fields, step) {
  const len = Nav.dist(a, b), st = step || 1;
  const n = Math.max(1, Math.ceil(len / st));
  const altOf = typeof altFt === 'function' ? altFt : () => altFt;
  const best = new Map(); const gaps = []; let gap = null;
  for (let i = 0; i <= n; i++) {
    const nm = len * i / n, p = len < 1e-9 ? a : Nav.along(a, b, i / n), alt = altOf(nm);
    let any = false;
    (fields || []).forEach((f) => {
      if (!isNum(f.lat) || !isNum(f.lon)) return;
      const d = Nav.dist(p, f);
      if (d <= Nav.glideReachNm(alt, isNum(f.elev) ? f.elev : 0)) {
        any = true;
        const cur = best.get(f.ident);
        if (!cur || d < cur.offNm) best.set(f.ident, { ident: f.ident, name: f.name, distNm: round1(nm), offNm: round1(d), lat: f.lat, lon: f.lon, elev: f.elev });
      }
    });
    if (!any) { if (!gap) { gap = { fromNm: round1(nm), toNm: round1(nm) }; gaps.push(gap); } else gap.toNm = round1(nm); }
    else gap = null;
  }
  return { fields: [...best.values()].sort((x, y) => x.distNm - y.distNm), gaps };
}

/* ---------------- terrain and obstacles ---------------- */
// Terrarium PNG pixel -> metres = R*256 + G + B/256 - 32768. Returned in ft.
function terrainFt(r, g, b) { return (r * 256 + g + b / 256 - 32768) * FT_PER_M; }
function tileOf(lat, lon, z) { // Web Mercator slippy tile + fractional pixel (0..256)
  const n = 2 ** z, la = Math.max(-85.0511, Math.min(85.0511, lat)) * RAD;
  const fx = (lon + 180) / 360 * n, fy = (1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2 * n;
  const x = Math.floor(fx), y = Math.floor(fy);
  return { x, y, px: (fx - x) * 256, py: (fy - y) * 256 };
}
function tilePixelLatLon(z, x, y, px, py) {
  const n = 2 ** z, lon = (x + px / 256) / n * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + py / 256) / n))) * DEG;
  return { lat, lon };
}
// Points covering the corridor of `corridorNm` either side of leg a-b (and round the ends): along every `stepNm`,
// across every `crossNm`. Only points within corridorNm of the leg are kept.
function corridorPoints(a, b, corridorNm, stepNm, crossNm) {
  const cor = corridorNm === undefined ? 5 : corridorNm, st = stepNm || 0.5, cr = crossNm || 1;
  const len = Nav.dist(a, b), course = Nav.brg(a, b), pts = [];
  const nAlong = Math.max(1, Math.ceil((len + 2 * cor) / st));
  for (let i = 0; i <= nAlong; i++) {
    const s = -cor + (len + 2 * cor) * i / nAlong;
    const base = s < 0 ? Nav.offset(a, course + 180, -s) : s > len ? Nav.offset(b, course, s - len) : (len < 1e-9 ? a : Nav.along(a, b, s / len));
    for (let c = -cor; c <= cor + 1e-9; c += cr) {
      const p = c === 0 ? base : Nav.offset(base, course + (c > 0 ? 90 : -90), Math.abs(c));
      if (Nav.xtrack(p, a, b) <= cor + 1e-6) pts.push({ lat: p.lat, lon: p.lon });
    }
  }
  return pts;
}
// Highest terrain over `points`. getTile(x, y) returns RGBA bytes (256*256*4) or null/undefined when the tile could
// not be loaded. A pixel neighbourhood of `radius` px (default 3, about 450 m at z11) is searched around each point
// so a narrow ridge between samples is not missed. Returns {ft, lat, lon} or null if there are no points, and
// {missing:true} semantics via `.missing` (count of unloadable tiles) so the caller never treats a gap as 0 ft.
function maxTerrain(points, z, getTile, radius) {
  const rad = radius === undefined ? 3 : radius;
  let best = null, missing = 0; const seenMissing = new Set();
  (points || []).forEach((p) => {
    const t = tileOf(p.lat, p.lon, z), data = getTile(t.x, t.y);
    if (!data) { const k = t.x + '/' + t.y; if (!seenMissing.has(k)) { seenMissing.add(k); missing++; } return; }
    const cx = Math.min(255, Math.floor(t.px)), cy = Math.min(255, Math.floor(t.py));
    for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x > 255 || y > 255) continue;
      const i = (y * 256 + x) * 4, ft = terrainFt(data[i], data[i + 1], data[i + 2]);
      if (!best || ft > best.ft) best = { ft, x: t.x, y: t.y, px: x + 0.5, py: y + 0.5 };
    }
  });
  if (!best) return missing ? { ft: null, lat: null, lon: null, missing } : null;
  const ll = tilePixelLatLon(z, best.x, best.y, best.px, best.py);
  return { ft: Math.round(best.ft), lat: ll.lat, lon: ll.lon, missing };
}
// Highest of terrain ({ft,lat,lon}|null) and obstacles ([{lat,lon,amsl}]) within `nm` of leg a-b.
// Returns {ft, lat, lon, kind:'terrain'|'obstacle', msa} or null when nothing is known (never 0).
function maxElevation(terrain, obstacles, a, b, nm) {
  const lim = nm === undefined ? 5 : nm;
  let best = (terrain && isNum(terrain.ft)) ? { ft: terrain.ft, lat: terrain.lat, lon: terrain.lon, kind: 'terrain' } : null;
  (obstacles || []).forEach((o) => {
    if (!isNum(o.amsl) || !isNum(o.lat) || !isNum(o.lon)) return;
    if (Nav.xtrack(o, a, b) <= lim && (!best || o.amsl > best.ft)) best = { ft: o.amsl, lat: o.lat, lon: o.lon, kind: 'obstacle' };
  });
  if (best) best.msa = Nav.msa(best.ft);
  return best;
}

/* ---------------- checks ----------------
 * ctx = {log, rows, solo, night, dep, dest, airports, conflicts, glide, sources, takeoffFuel}
 *  log: Nav.computeOfp output (rows, totals). rows: optional UI rows, same order (defaults to log.rows); a row may carry
 *  groundFt (terrain under the leg, for the 3000 ft AGL semicircular rule; default 0 = rule always applies).
 *  dep, dest: idents ('KGYR'). airports: LAT_AIRPORTS (airports.js). conflicts[i]: airspaceConflicts result for leg i.
 *  glide[i]: glide() result for leg i. sources: {terrain:{ok}, airspace:{ok}, obstacles:{ok}, winds:{ok}, ...}.
 *  takeoffFuel: USG (falls back to log.takeoffFuel).
 * Returns [{level:'warn'|'info', leg:int|null (0-based index into log.rows), code, text}]. Never blocks. */
const SRC_LABEL = { terrain: 'Terrain', airspace: 'Airspace', obstacles: 'Obstacles', winds: 'Winds aloft', airports: 'Airports', navaids: 'Navaids' };
const SRC_NOTE = { terrain: 'automatic MSA is missing: enter MSA by hand', airspace: 'airspace conflicts not checked', obstacles: 'obstacles not in MSA', winds: 'enter winds by hand', airports: 'emergency fields not checked', navaids: '' };
function checks(ctx) {
  const c = ctx || {}, log = c.log || { rows: [] }, rows = c.rows || log.rows || [];
  const L = log.rows || rows;
  const out = [];
  const add = (level, leg, code, text) => out.push({ level, leg, code, text });
  const nm = (r, i) => (r && (r.name || r.ident)) || 'point ' + (i + 1);
  const leg = (i) => 'Leg ' + (i + 1) + ' to ' + nm(rows[i] || L[i], i);
  let modeC = null;
  const sameApt = (x, y) => { const f = (v) => String(v || '').toUpperCase().replace(/^K(?=[A-Z0-9]{3}$)/, ''); return !!x && !!y && f(x) === f(y); };
  L.forEach((r, i) => {
    const ur = rows[i] || r, fixed = !!(r.fixed || ur.fixed);
    if (!fixed && isNum(r.dist) && r.dist > 30) add('warn', i, 'leg30', leg(i) + ' is ' + round1(r.dist) + ' NM. Legs over 30 NM need a checkpoint in between.');
    if (!fixed && isNum(r.mc) && isNum(r.alt)) {
      const g = isNum(ur.groundFt) ? ur.groundFt : 0;
      if (!Nav.semicircularOk(r.mc, r.alt, g)) add('warn', i, 'semicircular', leg(i) + ': ' + r.alt + ' ft on MC ' + String(Math.round(r.mc)).padStart(3, '0') + ' breaks the semicircular rule (' + (Nav.norm360(r.mc) < 180 ? 'odd thousands +500 eastbound' : 'even thousands +500 westbound') + ').');
    }
    if (!fixed && isNum(r.msa) && isNum(r.alt) && r.alt < r.msa) add('warn', i, 'belowMsa', leg(i) + ': ' + r.alt + ' ft is below the MSA of ' + r.msa + ' ft. Verify on the chart.');
    // airspace: Mode C veil once per flight, surface areas of the departure/arrival airport as info, one line per leg and class
    const flr = (k) => (k.lowerRef === 'SFC' ? (k.lowerFt > 0 ? k.lowerFt + ' ft AGL' : 'SFC') : (k.lowerFt === 0 ? 'SFC' : String(k.lowerFt)));
    const uniq = (arr) => arr.filter((v, j, a2) => a2.indexOf(v) === j);
    const groups = {}, shelves = [];
    ((c.conflicts && c.conflicts[i]) || []).forEach((k) => {
      if (k.cls === 'MODEC') { if (!modeC) modeC = String(k.name || '').replace(/\s*MODE C\s*$/i, '').trim() || 'this'; return; }
      if (k.kind === 'inside') {
        const isDep = i === 0 && k.ap && sameApt(k.ap, c.dep), isArr = i === L.length - 1 && k.ap && sameApt(k.ap, c.dest);
        if ((k.cls === 'B' || k.cls === 'C' || k.cls === 'D') && !(k.lowerFt > 0) && (isDep || isArr)) {
          const ap = (c.airports && c.airports.find && c.airports.find(k.ap)) ? c.airports.find(k.ap).icao : k.ap;
          [isDep ? 'Departure' : null, isArr ? 'Arrival' : null].filter(Boolean).forEach((w) => add('info', i, 'terminal', w + ' in ' + ap + ' Class ' + k.cls + ' - contact tower.'));
          return;
        }
        (groups[k.cls] = groups[k.cls] || []).push(k);
      } else shelves.push(k);
    });
    Object.keys(groups).forEach((cls) => {
      const g = groups[cls], from = Math.min(...g.map((k) => k.fromNm)), to = Math.max(...g.map((k) => k.toNm));
      const span = from === to ? 'at ' + from + ' NM' : from + '-' + to + ' NM';
      add('warn', i, 'airspace', leg(i) + ' enters ' + uniq(g.map((k) => k.name)).slice(0, 2).join(' / ') + ' ' + span + ' (floors ' + uniq(g.map(flr)).join('/') + '). Verify on the chart.');
    });
    if (shelves.length) {
      const low = Math.min(...shelves.map((k) => k.lowerFt)), from = Math.min(...shelves.map((k) => k.fromNm)), to = Math.max(...shelves.map((k) => k.toNm));
      add('info', i, 'airspace', leg(i) + ' passes under ' + uniq(shelves.map((k) => k.name)).slice(0, 2).join(' / ') + ' (lowest floor ' + low + ' ft) ' + (from === to ? 'at ' + from : from + '-' + to) + ' NM. Stay below ' + low + ' ft.');
    }
    const gl = c.glide && c.glide[i];
    if (gl && gl.gaps && gl.gaps.length) add(gl.gaps.every((g) => g.toNm - g.fromNm < 3) ? 'info' : 'warn', i, 'glideGap', leg(i) + ': no airport within glide reach ' + gl.gaps.map((g) => g.fromNm === g.toNm ? 'at ' + g.fromNm : g.fromNm + '-' + g.toNm).join(', ') + ' NM (9:1, 80% factor, no wind).');
    if (r.error === 'wind') add('warn', i, 'windErr', leg(i) + ': the wind is too strong for the TAS on this course. Enter a different wind or altitude.');
    if (isNum(r.plFuel) && isNum(r.minFuel) && r.plFuel < r.minFuel - 1e-9) add('warn', i, 'fuelReserve', leg(i) + ': planned fuel ' + r.plFuel.toFixed(1) + ' is below the minimum ' + r.minFuel.toFixed(1) + ' USG.');
  });
  if (modeC) add('info', null, 'modeC', 'Route is inside the ' + modeC + ' Mode C veil — transponder with altitude reporting required.');
  // airports
  const LAT = c.airports;
  const seen = new Set();
  const idents = [c.dep, c.dest].concat(rows.map((r) => r && r.ident)).filter(Boolean);
  if (LAT && LAT.find) idents.forEach((id) => {
    const a = LAT.find(id);
    if (!a || seen.has(a.id)) return; seen.add(a.id);
    const nm2 = a.icao || a.id;
    if (c.solo === true && !a.solo) add('warn', null, 'aptSolo', nm2 + ' is not approved for solo flights.');
    if (c.solo === false && !a.dual) add('warn', null, 'aptSolo', nm2 + ' is not approved for dual flights.');
    if (c.night) { if (!a.nightVfr) add('warn', null, 'aptNight', nm2 + ' is not approved for night VFR.'); }
    else if (!a.dayVfr) add('warn', null, 'aptNight', nm2 + ' is not approved for day VFR.');
    const lim = a.lim || {};
    const bits = [];
    if (lim.mtom) bits.push('MTOM ' + lim.mtom + ' lb');
    if (lim.maxTemp) bits.push('max temperature ' + lim.maxTemp + ' C');
    if (lim.hi) bits.push('high-elevation procedures');
    if (lim.noUse && lim.noUse.length) bits.push('runways ' + lim.noUse.join(', ') + ' not authorized');
    if (lim.noTO && lim.noTO.length) bits.push('no takeoff from runways ' + lim.noTO.join(', '));
    if (bits.length) add('info', null, 'aptLimits', nm2 + ' limits: ' + bits.join('; ') + '.');
  });
  // ATO procedures at GYR
  const isGyr = (id) => !!(LAT && LAT.find && LAT.find(id) && LAT.find(id).id === 'GYR');
  if (isGyr(c.dep) && L.length && !(rows[0] && rows[0].fixed) && !L[0].fixed) add('warn', 0, 'noAtoProc', 'Departure from KGYR does not use an ATO departure procedure.');
  if (isGyr(c.dest) && L.length) {
    const skip = isGyr(c.dep) ? 1 : 0;
    if (!L.some((r, i) => i >= skip && (r.fixed || (rows[i] && rows[i].fixed)))) add('warn', L.length - 1, 'noAtoProc', 'Arrival at KGYR does not use an ATO arrival procedure.');
  }
  const tof = isNum(c.takeoffFuel) ? c.takeoffFuel : log.takeoffFuel;
  if (isNum(tof) && tof > 56) add('warn', null, 'fuelUsable', 'Takeoff fuel ' + tof + ' USG is more than the 56 USG usable.');
  if (L.length > 18) add('warn', null, 'legs18', L.length + ' legs: the form holds 18. Only the first 18 will print.');
  Object.keys(c.sources || {}).forEach((k) => {
    const s = c.sources[k];
    if (s && s.ok === false) add('warn', null, 'dataMissing', (SRC_LABEL[k] || k) + ' data unavailable' + (SRC_NOTE[k] ? ': ' + SRC_NOTE[k] : '') + '.');
  });
  return out;
}

/* ---------------- altitude recommender ----------------
 * leg: {a:{lat,lon}, b:{lat,lon}, mc, dist, prevAlt?, groundFt?}
 * env: {msa, airspaces, winds:(alt)=>{dir (magnetic), spd}|null, cruise:(alt)=>{tas, ff}, minFt?, maxFt?, extra?:[ft]}
 * Candidates are semicircular altitudes from minFt (default 3000) to maxFt (default 12500) plus env.extra.
 * Returns [{alt, ok, reasons:[], gs, eet, fuel, rec}] ascending by altitude; `rec` marks the lowest ok one.
 * Never ok when below MSA, inside conflicting airspace, or when the wind triangle fails. */
function recommendAlts(leg, env) {
  const e = env || {}, lg = leg || {};
  if (!isNum(lg.mc)) return [];
  const lo = isNum(e.minFt) ? e.minFt : 3000, hi = isNum(e.maxFt) ? e.maxFt : 12500;
  const alts = Nav.semicircularAlts(lg.mc, lo, hi).concat(e.extra || []).filter((v, i, s) => s.indexOf(v) === i).sort((x, y) => x - y);
  const dist = isNum(lg.dist) ? lg.dist : (lg.a && lg.b ? Nav.dist(lg.a, lg.b) : 0);
  const res = alts.map((alt) => {
    const reasons = [];
    let gs = null, eet = null, fuel = null;
    if (isNum(e.msa) && alt < e.msa) reasons.push('below MSA ' + e.msa + ' ft');
    if (lg.a && lg.b && e.airspaces) {
      const prof = legProfile([{ dist, alt, prevAlt: isNum(lg.prevAlt) ? lg.prevAlt : alt, last: false }])[0];
      airspaceConflicts(lg.a, lg.b, prof, e.airspaces, { groundFt: lg.groundFt }).filter((k) => k.kind === 'inside')
        .forEach((k) => reasons.push('inside ' + k.name + ' (' + k.cls + ')'));
    }
    const w = e.winds ? e.winds(alt) : null, cr = e.cruise ? e.cruise(alt) : null;
    if (!cr) reasons.push('no performance data');
    else {
      const t = Nav.windTriangle({ mc: lg.mc, tas: cr.tas, wdir: w ? w.dir : 0, wspd: w ? w.spd : 0 });
      if (t.error) reasons.push('wind too strong');
      else { gs = t.gs; eet = Nav.eet(dist, gs); fuel = round1(eet / 60 * cr.ff); }
    }
    return { alt, ok: reasons.length === 0, reasons, gs, eet, fuel, rec: false };
  });
  const first = res.find((r) => r.ok);
  if (first) first.rec = true;
  return res;
}

const Safety = { interpWind, legProfile, altAt, pointInPolygon, airspaceConflicts, addsAlt, fromAddsAirspace,
  glide, terrainFt, tileOf, tilePixelLatLon, corridorPoints, maxTerrain, maxElevation, checks, recommendAlts, UNLIMITED };
if (typeof module !== 'undefined' && module.exports) module.exports = Safety; else root.Safety = Safety;
})(typeof self !== 'undefined' ? self : this);
