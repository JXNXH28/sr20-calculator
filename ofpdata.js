// OFP data layer (network only): airspace, airports, navaids, obstacles, terrain and winds aloft.
// Classic script (global OfpData) that also loads in node for smoke tests. Needs Nav and Safety (nav.js, safety.js).
// Nothing here throws on a network failure. Every call resolves to {data, ok, source, at}:
//   ok false = the source is unavailable (data is an empty list or null, NEVER zero), at = null.
//   A cached copy is used while it is younger than 30 days, and as a stale fallback when the network fails
//   (then ok is true, stale is true, and source ends in " (cached)").
// ADDS = FAA aeronautical data on ArcGIS (the same host autofill.js uses). Winds aloft are never cached.
(function (root) {
'use strict';

const node = typeof module !== 'undefined' && module.exports && typeof require === 'function';
const Nav = node ? require('./nav.js') : root.Nav;
const Safety = node ? require('./safety.js') : root.Safety;

const ADDS = 'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/';
const TERRAIN = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/';
const TZ = 11;                                   // terrain tile zoom (about 64 m per pixel at 33 N)
const CKEY = 'sr20calc.ofp.v1', TTL = 30 * 86400000;
const MAX_PAGES = 6, SIMPLIFY = 0.001;           // ArcGIS page limit; polygon simplification in degrees (about 100 m)

const isNum = (v) => typeof v === 'number' && isFinite(v);
const result = (data, ok, source, at, extra) => Object.assign({ data, ok, source, at: ok ? (at || Date.now()) : null }, extra || {});

async function jget(u, ms) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms || 12000);
  try {
    const r = await fetch(u, { signal: c.signal });
    if (!r.ok) throw new Error(u.split('?')[0] + ' HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

/* ---------- cache (localStorage, 30 days) ---------- */
let mem = null;
function store() {
  if (mem) return mem;
  mem = {};
  try { mem = JSON.parse(localStorage.getItem(CKEY)) || {}; } catch (e) { mem = {}; }
  return mem;
}
function save() {
  const s = store();
  for (let tries = 0; tries < 6; tries++) {
    try { localStorage.setItem(CKEY, JSON.stringify(s)); return; } catch (e) {
      const keys = Object.keys(s).sort((a, b) => s[a].t - s[b].t);   // quota: drop the oldest entries
      if (!keys.length) return;
      keys.slice(0, Math.max(1, Math.ceil(keys.length / 3))).forEach((k) => { delete s[k]; });
    }
  }
}
// Bounding boxes are widened to a 0.25 degree grid so neighbouring routes share cache entries.
function snap(bbox) {
  const g = 0.25;
  return { s: Math.floor(bbox.s / g) * g, w: Math.floor(bbox.w / g) * g, n: Math.ceil(bbox.n / g) * g, e: Math.ceil(bbox.e / g) * g };
}
function validBbox(b) { return b && isNum(b.s) && isNum(b.w) && isNum(b.n) && isNum(b.e) && b.s <= b.n && b.w <= b.e; }
async function cached(kind, bbox, source, load) {
  if (!validBbox(bbox)) return result([], false, source);
  const bb = snap(bbox), key = kind + ':' + [bb.s, bb.w, bb.n, bb.e].join(',');
  const hit = store()[key];
  if (hit && Date.now() - hit.t < TTL) return result(hit.d, true, source + ' (cached)', hit.t, { stale: false });
  try {
    const r = await load(bb);
    if (r.ok) { store()[key] = { t: Date.now(), d: r.data }; save(); return result(r.data, true, source); }
    if (hit) return result(hit.d, true, source + ' (cached)', hit.t, { stale: true });
    return result(r.data, false, source, null, { partial: !!r.partial });
  } catch (e) {
    if (hit) return result(hit.d, true, source + ' (cached)', hit.t, { stale: true });
    return result([], false, source);
  }
}

/* ---------- ADDS ---------- */
function addsUrl(layer, bbox, where, fields, geom, offset) {
  const p = new URLSearchParams({
    where: where || '1=1', geometry: [bbox.w, bbox.s, bbox.e, bbox.n].join(','), geometryType: 'esriGeometryEnvelope',
    inSR: '4326', outSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields: fields, returnGeometry: geom ? 'true' : 'false', f: 'json',
  });
  if (geom === 'poly') p.set('maxAllowableOffset', String(SIMPLIFY));
  if (offset) p.set('resultOffset', String(offset));
  return ADDS + layer + '/FeatureServer/0/query?' + p;
}
// All pages of a query (ArcGIS caps one answer, usually at 2000 features). Throws if the service errors.
async function addsAll(layer, bbox, where, fields, geom) {
  const feats = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const j = await jget(addsUrl(layer, bbox, where, fields, geom, feats.length));
    if (j.error) throw new Error(layer + ': ' + (j.error.message || 'error'));
    const f = j.features || [];
    feats.push(...f);
    if (!j.exceededTransferLimit || !f.length) break;
  }
  return feats;
}
const AS_FIELDS = 'NAME,IDENT,CLASS,LOCAL_TYPE,UPPER_VAL,UPPER_UOM,UPPER_CODE,LOWER_VAL,LOWER_UOM,LOWER_CODE';
const SUA_FIELDS = 'NAME,TYPE_CODE,UPPER_VAL,UPPER_UOM,UPPER_CODE,LOWER_VAL,LOWER_UOM,LOWER_CODE,TIMESOFUSE';

// Class B/C/D, Mode C veil (Class_Airspace; Class A and E are left out: A starts at 18000 ft and E needs no
// clearance) and special-use airspace (R, P, MOA, ALERT, W, DNGR). If one of the two layers fails the answer is
// ok:false with partial:true and whatever the other layer gave.
function airspace(bbox) {
  return cached('airspace', bbox, 'FAA ADDS', async (bb) => {
    const [a, b] = await Promise.allSettled([
      addsAll('Class_Airspace', bb, "CLASS IS NULL OR CLASS NOT IN ('A','E')", AS_FIELDS, 'poly'),
      addsAll('Special_Use_Airspace', bb, '1=1', SUA_FIELDS, 'poly'),
    ]);
    const data = [];
    if (a.status === 'fulfilled') a.value.forEach((f) => { const o = Safety.fromAddsAirspace(f, 'class'); if (o) data.push(o); });
    if (b.status === 'fulfilled') b.value.forEach((f) => { const o = Safety.fromAddsAirspace(f, 'sua'); if (o) data.push(o); });
    const ok = a.status === 'fulfilled' && b.status === 'fulfilled';
    return { ok, data, partial: !ok && data.length > 0 };
  });
}

// Airports (type AD = land airport; heliports, seaplane bases etc. are not emergency fields).
// {ident (ICAO if there is one), faa, name, lat, lon, elev, type, private}
function airports(bbox) {
  return cached('airports', bbox, 'FAA ADDS', async (bb) => {
    const f = await addsAll('US_Airport', bb, "TYPE_CODE = 'AD'", 'IDENT,ICAO_ID,NAME,ELEVATION,TYPE_CODE,PRIVATEUSE,OPERSTATUS,MIL_CODE', 'pt');
    const data = f.filter((x) => x.geometry && isNum(x.geometry.x) && (!x.attributes.OPERSTATUS || x.attributes.OPERSTATUS === 'OPERATIONAL')).map((x) => {
      const a = x.attributes;
      return { ident: a.ICAO_ID || a.IDENT, faa: a.IDENT, name: a.NAME, lat: x.geometry.y, lon: x.geometry.x, elev: isNum(a.ELEVATION) ? a.ELEVATION : null,
        type: a.TYPE_CODE, private: a.PRIVATEUSE === 1 || a.MIL_CODE === 'MIL' };
    });
    return { ok: true, data };
  });
}
// Navaids {ident, name, lat, lon, elev:null, type: CLASS_TXT e.g. 'H-VORTACW', private:false}
function navaids(bbox) {
  return cached('navaids', bbox, 'FAA ADDS', async (bb) => {
    const f = await addsAll('NAVAIDSystem', bb, '1=1', 'IDENT,NAME_TXT,CLASS_TXT,STATUS', 'pt');
    return { ok: true, data: f.filter((x) => x.geometry && isNum(x.geometry.x)).map((x) => ({ ident: x.attributes.IDENT, name: x.attributes.NAME_TXT, lat: x.geometry.y, lon: x.geometry.x,
      elev: null, type: x.attributes.CLASS_TXT, private: false })) };
  });
}
// Digital Obstacle File {lat, lon, amsl, agl, type}
function obstacles(bbox) {
  return cached('obstacles', bbox, 'FAA DOF', async (bb) => {
    const f = await addsAll('Digital_Obstacle_File', bb, '1=1', 'AGL,AMSL,Type_Code', 'pt');
    return { ok: true, data: f.filter((x) => x.geometry && isNum(x.geometry.x) && isNum(x.attributes.AMSL))
      .map((x) => ({ lat: x.geometry.y, lon: x.geometry.x, amsl: x.attributes.AMSL, agl: x.attributes.AGL, type: String(x.attributes.Type_Code || '').trim() })) };
  });
}

/* ---------- terrain (AWS Terrarium tiles, decoded with a canvas) ---------- */
const tiles = new Map();                     // "x/y" -> Promise<Uint8ClampedArray|null>, kept for the page's lifetime
// Default decoder: PNG bytes -> RGBA. Browsers only; tests can replace OfpData.decoder.
async function canvasDecode(buf) {
  const blob = new Blob([buf], { type: 'image/png' });
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  let ctx;
  if (typeof OffscreenCanvas !== 'undefined') ctx = new OffscreenCanvas(256, 256).getContext('2d', { willReadFrequently: true });
  else { const c = document.createElement('canvas'); c.width = c.height = 256; ctx = c.getContext('2d', { willReadFrequently: true }); }
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, 256, 256).data;
}
function tile(x, y) {
  const k = x + '/' + y;
  if (!tiles.has(k)) {
    const p = (async () => {
      const c = new AbortController(), t = setTimeout(() => c.abort(), 15000);
      try {
        const r = await fetch(TERRAIN + TZ + '/' + x + '/' + y + '.png', { signal: c.signal });
        if (!r.ok) return null;
        return await OfpData.decoder(await r.arrayBuffer());
      } catch (e) { return null; } finally { clearTimeout(t); }
    })();
    tiles.set(k, p);
    p.then((d) => { if (!d) tiles.delete(k); });   // a failed tile is retried next time
    if (tiles.size > 60) tiles.delete(tiles.keys().next().value);
  }
  return tiles.get(k);
}
// Highest terrain within corridorNm (default 5) of leg a-b: {ft, lat, lon}. ok:false (data null) if any tile is missing,
// because a missing tile would hide the highest ground.
async function terrainMax(a, b, corridorNm) {
  try {
    const pts = Safety.corridorPoints(a, b, corridorNm === undefined ? 5 : corridorNm, 0.5, 1);
    const need = new Map();
    pts.forEach((p) => { const t = Safety.tileOf(p.lat, p.lon, TZ); need.set(t.x + '/' + t.y, t); });
    const got = new Map();
    await Promise.all([...need.values()].map(async (t) => { got.set(t.x + '/' + t.y, await tile(t.x, t.y)); }));
    const m = Safety.maxTerrain(pts, TZ, (x, y) => got.get(x + '/' + y));
    if (!m || m.missing || !isNum(m.ft)) return result(null, false, 'AWS Terrain Tiles');
    return result({ ft: m.ft, lat: m.lat, lon: m.lon }, true, 'AWS Terrain Tiles');
  } catch (e) { return result(null, false, 'AWS Terrain Tiles'); }
}

/* ---------- winds aloft ---------- */
const OM_LEVELS = [1000, 925, 850, 800, 700, 600, 500];
function omUrl(lat, lon) {
  const h = OM_LEVELS.map((l) => ['wind_speed_', 'wind_direction_', 'temperature_', 'geopotential_height_'].map((v) => v + l + 'hPa').join(',')).join(',');
  return 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({ latitude: lat.toFixed(3), longitude: lon.toFixed(3), models: 'gfs_seamless',
    wind_speed_unit: 'kn', timeformat: 'unixtime', forecast_days: '3', hourly: h });
}
// Open-Meteo hourly pressure-level JSON -> wind at (timeMs, altFt). Direction is TRUE. Level height is geopotential height.
function omWind(j, timeMs, altFt) {
  const h = j && j.hourly, t = h && h.time;
  if (!t || !t.length) return null;
  let bi = 0, bd = Infinity;
  t.forEach((u, i) => { const d = Math.abs(u * 1000 - timeMs); if (d < bd) { bd = d; bi = i; } });
  const lv = [];
  OM_LEVELS.forEach((l) => {
    const sp = h['wind_speed_' + l + 'hPa'], dr = h['wind_direction_' + l + 'hPa'], tp = h['temperature_' + l + 'hPa'], gh = h['geopotential_height_' + l + 'hPa'];
    if (!sp || !dr || !gh) return;
    if (isNum(sp[bi]) && isNum(dr[bi]) && isNum(gh[bi])) lv.push({ alt: gh[bi] * 3.28084, dir: dr[bi], spd: sp[bi], temp: tp && isNum(tp[bi]) ? tp[bi] : null });
  });
  const w = Safety.interpWind(lv, altFt);
  return w ? { dir: w.dir, spd: w.spd, tempC: w.temp } : null;
}
// {lat, lon, timeMs, altFt} -> {dir (TRUE), spd, tempC, source:'Open-Meteo', issued:null}. Not cached.
async function windsAloft(q) {
  const lat = q.lat, lon = q.lon, timeMs = isNum(q.timeMs) ? q.timeMs : Date.now(), altFt = q.altFt;
  if (!isNum(lat) || !isNum(lon) || !isNum(altFt)) return result(null, false, 'winds aloft');
  // Open-Meteo pressure levels (GFS). The FAA FB product was retired (SCN26-47), so this is the only source.
  try {
    const j = await jget(omUrl(lat, lon));
    const w = omWind(j, timeMs, altFt);
    if (w) return result({ dir: w.dir, spd: w.spd, tempC: w.tempC, source: 'Open-Meteo', issued: null }, true, 'Open-Meteo (GFS)');
  } catch (e) { /* fall through */ }
  return result(null, false, 'winds aloft');
}

// Like jget, but an empty answer (204 / empty body: no reports) is an empty list
async function jlist(u, ms) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms || 12000);
  try {
    const r = await fetch(u, { signal: c.signal });
    if (!r.ok) throw new Error(u.split('?')[0] + ' HTTP ' + r.status);
    const txt = r.status === 204 ? '' : (await r.text()).trim();
    return txt ? JSON.parse(txt) : [];
  } finally { clearTimeout(t); }
}
/* ---------- weather hazards, PIREPs, TFRs, METAR/TAF (relays, in-memory cache 5 min) ---------- */
const WX_TTL = 5 * 60000, wxMem = new Map();
async function wxCached(key, force, load) {
  const hit = wxMem.get(key);
  if (!force && hit && Date.now() - hit.t < WX_TTL) return hit.v;
  const v = await load();
  if (v && v.ok) wxMem.set(key, { t: Date.now(), v });
  return v;
}
const fnum = (v) => { const n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) ? n : null; };
const ring = (coords) => (coords || []).map((c) => [fnum(c.lat), fnum(c.lon)]).filter((p) => p[0] !== null && p[1] !== null);
// "120" (hundreds of ft) -> 12000, 'SFC' -> 0, anything else -> null
const hund = (v, fzl) => {
  if (v === null || v === undefined || v === '') return null;
  if (/^SFC$/i.test(String(v))) return 0;
  if (/^FZL$/i.test(String(v))) return fzl !== undefined && fnum(fzl) !== null ? fnum(fzl) * 100 : null;
  const n = fnum(v); return n === null ? null : n * 100;
};
const isoMs = (s) => { if (!s) return null; const t = Date.parse(/(Z|[+-]\d\d:?\d\d)$/.test(s) ? s : s + 'Z'); return isFinite(t) ? t : null; };
function ringBox(r) {
  let s = 90, n = -90, w = 180, e = -180;
  r.forEach((p) => { s = Math.min(s, p[0]); n = Math.max(n, p[0]); w = Math.min(w, p[1]); e = Math.max(e, p[1]); });
  return { s, n, w, e };
}
const boxHit = (a, b) => a.n >= b.s && a.s <= b.n && a.e >= b.w && a.w <= b.e;
function expandBbox(b, nm) {
  const dl = nm / 60, dn = nm / 60 / Math.max(0.2, Math.cos((b.s + b.n) / 2 * Math.PI / 180));
  return { s: b.s - dl, n: b.n + dl, w: b.w - dn, e: b.e + dn };
}
function itemBox(it) {
  const boxes = [];
  (it.polys || []).forEach((r) => { if (r.length) boxes.push(ringBox(r)); });
  (it.snapshots || []).forEach((sn) => (sn.polys || []).forEach((r) => { if (r.length) boxes.push(ringBox(r)); }));
  (it.circles || []).forEach((c) => { boxes.push(expandBbox({ s: c.lat, n: c.lat, w: c.lon, e: c.lon }, c.radiusNm)); });
  return boxes;
}
function normAirSigmet(a) {
  if (!a || !Array.isArray(a.coords)) return null;
  const type = String(a.airSigmetType || '').toUpperCase(), hz = String(a.hazard || '').toUpperCase();
  const kind = type === 'AIRMET' ? 'AIRMET' : hz === 'CONVECTIVE' ? 'CSIGMET' : 'SIGMET';
  const r = ring(a.coords); if (r.length < 3) return null;
  return { id: [kind, a.seriesId || '', a.validTimeFrom || ''].join('-'), kind, hazard: hz || type, sev: a.severity === undefined || a.severity === null ? null : a.severity,
    from: fnum(a.validTimeFrom) !== null ? a.validTimeFrom * 1000 : null, to: fnum(a.validTimeTo) !== null ? a.validTimeTo * 1000 : null,
    baseFt: fnum(a.altitudeLow1), topFt: fnum(a.altitudeHi1), polys: [r], circles: [], raw: a.rawAirSigmet || '' };
}
function normCwa(a) {
  if (!a || !Array.isArray(a.coords)) return null;
  const r = ring(a.coords); if (r.length < 3) return null;
  return { id: 'CWA-' + (a.cwsu || '') + '-' + (a.validTimeFrom || ''), kind: 'CWA', hazard: String(a.hazard || '').toUpperCase() + (a.qualifier ? ' ' + a.qualifier : ''), sev: null,
    from: fnum(a.validTimeFrom) !== null ? a.validTimeFrom * 1000 : null, to: fnum(a.validTimeTo) !== null ? a.validTimeTo * 1000 : null,
    baseFt: fnum(a.base), topFt: fnum(a.top), polys: [r], circles: [], raw: a.rawText || '' };
}
// Series by hazard (the product the relay returns can differ from the type asked for)
const GSERIES = (hz, type) => (/^(IFR|MT_OBSC)$/.test(hz) ? 'SIERRA' : /^(TURB|SFC_WND|LLWS)/.test(hz) ? 'TANGO' : /^(ICE|FZLVL)/.test(hz) ? 'ZULU' : String(type || '').toUpperCase());
// G-AIRMET snapshots (one per forecast hour) of the same hazard+tag are merged into one item with `snapshots`.
function normGairmet(list, type) {
  const groups = new Map();
  (list || []).forEach((g) => {
    if (!g || g.geometryType !== 'AREA' || /^(FZLVL|M_FZLVL)$/.test(String(g.hazard))) return;
    const r = ring(g.coords), vm = isoMs(g.validTime); if (r.length < 3 || vm === null) return;
    const k = g.hazard + '|' + (g.tag || '');
    let it = groups.get(k);
    if (!it) {
      const hz = String(g.hazard).replace('MT_OBSC', 'MTN OBSCN');
      it = { id: 'G-' + k, kind: 'AIRMET', hazard: hz, sev: GSERIES(g.hazard, type), from: null, to: null, baseFt: null, topFt: null, polys: [], circles: [], snapshots: [], raw: '' };
      groups.set(k, it);
    }
    const baseFt = hund(g.base, g.fzlbase), topFt = hund(g.top, g.fzltop);
    let sn = it.snapshots.find((x) => x.validMs === vm);
    if (!sn) { sn = { validMs: vm, polys: [], baseFt, topFt }; it.snapshots.push(sn); }
    sn.polys.push(r);
  });
  const out = [];
  groups.forEach((it) => {
    it.snapshots.sort((a, b) => a.validMs - b.validMs);
    it.from = it.snapshots[0].validMs - 90 * 60000; it.to = it.snapshots[it.snapshots.length - 1].validMs + 90 * 60000;
    it.baseFt = it.snapshots[0].baseFt; it.topFt = it.snapshots[0].topFt;
    it.raw = 'G-AIRMET ' + it.sev + ' ' + it.hazard;
    out.push(it);
  });
  return out;
}
// bbox {s,w,n,e} -> {data:[Safety hazard items], ok, source, at, partial}; ok when at least one product answered
async function hazards(bbox, force) {
  const src = 'aviationweather.gov';
  if (!validBbox(bbox)) return result([], false, src);
  const eb = expandBbox(bbox, 50), key = 'hz:' + [bbox.s, bbox.w, bbox.n, bbox.e].map((v) => v.toFixed(1)).join(',');
  return wxCached(key, force, async () => {
    const jobs = [
      jlist('/api/aw/airsigmet').then((l) => (l || []).map(normAirSigmet)),
      jlist('/api/aw/cwa').then((l) => (l || []).map(normCwa)),
      ...['sierra', 'tango', 'zulu'].map((t) => jlist('/api/aw/gairmet?type=' + t).then((l) => normGairmet(l, t))),
    ];
    const rs = await Promise.allSettled(jobs);
    const okN = rs.filter((r) => r.status === 'fulfilled').length;
    if (!okN) return result([], false, src);
    const items = [], ids = new Set();
    rs.forEach((r) => { if (r.status === 'fulfilled') r.value.forEach((it) => { if (it && !ids.has(it.id) && itemBox(it).some((b) => boxHit(b, eb))) { ids.add(it.id); items.push(it); } }); });
    return result(items, true, src, Date.now(), { partial: okN < rs.length });
  });
}
// PIREPs near the route: bbox widened by 25 NM, split into requests of at most 15 degrees
async function pireps(bbox, force) {
  const src = 'aviationweather.gov';
  if (!validBbox(bbox)) return result([], false, src);
  const b = expandBbox(bbox, 25);
  const s = Math.max(15, b.s), n = Math.min(72, b.n), w = Math.max(-180, b.w), e = Math.min(-60, b.e);
  if (!(s < n) || !(w < e)) return result([], true, src);
  const key = 'pr:' + [s, w, n, e].map((v) => v.toFixed(1)).join(',');
  return wxCached(key, force, async () => {
    const cells = [], ns = Math.ceil((n - s) / 14.9), nw = Math.ceil((e - w) / 14.9);
    for (let i = 0; i < ns; i++) for (let j = 0; j < nw; j++) {
      const la0 = s + (n - s) * i / ns, la1 = s + (n - s) * (i + 1) / ns, lo0 = w + (e - w) * j / nw, lo1 = w + (e - w) * (j + 1) / nw;
      cells.push([la0, lo0, la1, lo1].map((v) => v.toFixed(2)).join(','));
    }
    const rs = await Promise.allSettled(cells.map((c) => jlist('/api/aw/pirep?bbox=' + c + '&age=3')));
    const okN = rs.filter((r) => r.status === 'fulfilled').length;
    if (!okN) return result([], false, src);
    const seen = new Set(), out = [];
    rs.forEach((r) => { if (r.status === 'fulfilled') (r.value || []).forEach((p) => { const k = p.obsTime + '|' + p.rawOb; if (!seen.has(k)) { seen.add(k); out.push(p); } }); });
    return result(out, true, src, Date.now(), { partial: okN < rs.length });
  });
}
// Rough state boxes [s, n, w, e], enough to decide which states' TFRs to ask for
const STATE_BOX = { AZ: [31.3, 37.0, -114.8, -109.0], CA: [32.5, 42.0, -124.5, -114.1], NV: [35.0, 42.0, -120.0, -114.0], UT: [37.0, 42.0, -114.05, -109.0],
  NM: [31.3, 37.0, -109.05, -103.0], CO: [37.0, 41.0, -109.05, -102.0], TX: [25.8, 36.5, -106.7, -93.5] };
function statesFor(bbox) {
  if (!validBbox(bbox)) return [];
  const b = expandBbox(bbox, 25);
  return Object.keys(STATE_BOX).filter((k) => { const x = STATE_BOX[k]; return boxHit({ s: x[0], n: x[1], w: x[2], e: x[3] }, b); });
}
function tfrItems(items) {
  const out = [];
  (items || []).forEach((t) => (t.shapes || []).forEach((sh, k) => {
    const polys = sh.kind === 'poly' ? [(sh.pts || []).map((p) => [p[0], p[1]])] : [];
    const circles = sh.kind === 'circle' ? [{ lat: sh.lat, lon: sh.lon, radiusNm: sh.radiusNm }] : [];
    if (!polys.length && !circles.length) return;
    out.push({ id: t.id, kind: 'TFR', hazard: t.type || 'TFR', sev: null, name: t.name || '', state: t.state || '', from: isoMs(t.from), to: isoMs(t.to),
      baseFt: fnum(sh.floorFt) !== null ? sh.floorFt : fnum(t.floorFt), topFt: fnum(sh.ceilFt) !== null ? sh.ceilFt : fnum(t.ceilFt),
      agl: !!(sh.floorAgl || sh.ceilAgl), polys, circles, raw: t.text || t.name || '', shape: k });
  }));
  return out;
}
async function tfrs(states, force) {
  const src = 'tfr.faa.gov';
  const st = (states || []).filter((s) => /^[A-Z]{2}$/.test(s)).slice(0, 6);
  if (!st.length) return result([], true, src);
  return wxCached('tfr:' + st.join(','), force, async () => {
    try {
      const j = await jget('/api/tfr?states=' + st.join(','), 25000);
      return result(tfrItems(j && j.items), true, src, Date.now(), { partial: !!(j && j.skipped) });
    } catch (e) { return result([], false, src); }
  });
}
async function metarTaf(icao, force) {
  const src = 'aviationweather.gov', id = String(icao || '').toUpperCase();
  if (!/^[A-Z0-9]{3,4}$/.test(id)) return result({ metars: [], taf: null }, false, src);
  return wxCached('mt:' + id, force, async () => {
    const [m, t] = await Promise.allSettled([jlist('/api/aw/metar?ids=' + id + '&hours=3'), jlist('/api/aw/taf?ids=' + id)]);
    if (m.status !== 'fulfilled' && t.status !== 'fulfilled') return result({ metars: [], taf: null }, false, src);
    const taf = t.status === 'fulfilled' && Array.isArray(t.value) ? t.value[0] || null : null;
    return result({ metars: m.status === 'fulfilled' && Array.isArray(m.value) ? m.value : [], taf }, true, src, Date.now(), { partial: m.status !== 'fulfilled' || t.status !== 'fulfilled' });
  });
}

const OfpData = { airspace, airports, navaids, obstacles, terrainMax, windsAloft, hazards, pireps, tfrs, metarTaf, statesFor, decoder: canvasDecode,
  // exposed for tests and smoke checks
  _urls: { addsUrl, omUrl, terrainTile: (x, y) => TERRAIN + TZ + '/' + x + '/' + y + '.png' }, _omWind: omWind, _norm: { normAirSigmet, normGairmet, normCwa, tfrItems }, TZ };
if (node) module.exports = OfpData; else root.OfpData = OfpData;
})(typeof self !== 'undefined' ? self : this);
