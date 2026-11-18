// Automatic airport + weather loading, one run per sheet (each takeoff and the destination landing).
// Starts by itself once route, date and departure time are set; reruns only for sheets whose airport or time changed.
// Sources: aviationweather.gov via our /api/aw relay (airport, METAR, TAF), FAA ADDS (elevation in feet; runways for
// fields aviationweather does not know), Open-Meteo (forecast model). Which source answers for a time: wx.js.
(function () {
'use strict';
// app.js starts after sign-in and then announces window.App with an "app-ready" event
function boot() {
const W = window.Wx, A = window.App, LAT = window.LAT_AIRPORTS;
if (A.noserver) return;
const offline = location.protocol === 'file:';

// fetch JSON with a time limit; `signal` cancels it when a newer run replaces this one
async function jget(u, signal, ms = 8000) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  const stop = () => c.abort();
  if (signal) { if (signal.aborted) c.abort(); else signal.addEventListener('abort', stop, { once: true }); }
  try {
    const r = await fetch(u, { signal: c.signal });
    if (!r.ok) throw new Error(`${u.split('?')[0]} → HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); if (signal) signal.removeEventListener('abort', stop); }
}
const soft = (pr, dflt) => pr.catch(() => dflt);

function tzOffsetMs(utcMs, tz) {
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(utcMs)).forEach((x) => { p[x.type] = x.value; });
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000;
}
function localToUtc(date, time, tz) {
  const [y, m, d] = date.split('-').map(Number), [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const t = guess - tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(t, tz);
}
const localHM = (ms, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const OM = 'https://api.open-meteo.com/v1/forecast?models=gfs_seamless&wind_speed_unit=kn&timezone=auto&timeformat=unixtime';
const OMH = '&hourly=temperature_2m,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m';
const ADDS = 'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/';
const q = (s) => encodeURIComponent(s);

/* ---------- airport data (cached in the browser for 30 days) ---------- */
const CKEY = 'sr20calc.apt.v1', TTL = 30 * 86400000;
let cache = {};
try { cache = JSON.parse(localStorage.getItem(CKEY)) || {}; } catch (e) { /* ignore */ }
const pending = {};
function airport(icao) { // not cancellable: several sheets share one lookup
  const hit = cache[icao];
  if (hit && Date.now() - hit.t < TTL) return Promise.resolve(hit.d);
  if (!pending[icao]) {
    pending[icao] = loadAirport(icao).then((d) => {
      if (!d.ends.length || !d.tz) return d; // incomplete answer: do not keep it
      cache[icao] = { t: Date.now(), d };
      try { localStorage.setItem(CKEY, JSON.stringify(cache)); } catch (e) { /* ignore */ }
      return d;
    }).finally(() => { delete pending[icao]; });
  }
  return pending[icao];
}
// -> { name, lat, lon, elev, elevSrc, mv, tz, country, ends: [{id,len,surf,hdgT,hdg}], st: [[metarStation, NM]], taf }
async function loadAirport(icao, signal) {
  const lat = LAT.find(icao);
  const ident = lat ? lat.id : icao.replace(/^K(?=[A-Z0-9]{3}$)/, '');
  const awId = icao.length === 4 ? icao : 'K' + icao; // A39 and P08 report as KA39 / KP08
  const [awList, faaJ] = await Promise.all([
    soft(jget(`/api/aw/airport?ids=${awId}`, signal), null),
    soft(jget(`${ADDS}US_Airport/FeatureServer/0/query?outFields=IDENT,NAME,ELEVATION,GLOBAL_ID&returnGeometry=true&outSR=4326&f=json&where=${q(`IDENT='${ident}'`)}`, signal), null),
  ]);
  const aw = awList && awList[0], ff = faaJ && faaJ.features && faaJ.features[0];
  const faa = ff && { elev: ff.attributes.ELEVATION, name: ff.attributes.NAME, gid: ff.attributes.GLOBAL_ID, lat: ff.geometry.y, lon: ff.geometry.x };
  if (!aw && !faa) {
    if (awList === null && faaJ === null) throw new Error('Cannot reach the airport data services – check your connection, then ↻ refresh.');
    throw new Error('Airport not found: ' + icao);
  }
  const d = {
    name: lat ? lat.name : (aw ? aw.name : faa.name).trim(),
    lat: aw ? aw.lat : faa.lat, lon: aw ? aw.lon : faa.lon,
    elev: faa ? faa.elev : lat ? lat.elev : aw.elev * 3.28084,
    elevSrc: faa ? 'FAA' : lat ? 'LAT list' : 'approx. ±3 ft',
    country: aw ? aw.country : 'US', tz: lat ? lat.tz : null,
  };
  if (aw) {
    d.mv = W.magVar(aw.magdec); d.ends = W.runwayEnds(aw); d.st = [[awId, 0]]; d.taf = awId;
  } else {
    // no aviationweather record (E63, 1AZ0, P20, E25 …): runways from FAA, weather from stations nearby
    d.mv = lat && lat.mv !== undefined ? lat.mv : null;
    d.st = (lat && lat.wx) || []; d.taf = null;
    const rw = await soft(jget(`${ADDS}Runways/FeatureServer/0/query?outFields=DESIGNATOR,LENGTH,COMP_CODE&returnGeometry=true&outSR=4326&f=json&where=${q(`AIRPORT_ID='${faa.gid}'`)}`, signal), null);
    d.ends = W.runwaysFromFaa(rw && rw.features, d.mv);
  }
  if (!d.tz) { // not on the LAT list: ask the forecast service for the time zone
    const z = await soft(jget(`${OM}&current=temperature_2m&latitude=${d.lat}&longitude=${d.lon}`, signal), null);
    d.tz = (z && z.timezone) || null;
  }
  return d;
}

/* ---------- one sheet ---------- */
const ctrl = {};  // point -> AbortController of the running fetch
const tried = {}; // point -> key of the last attempt in this session (also failed ones, so errors do not loop)
async function run(p, icao, when, landing, key) {
  if (ctrl[p]) ctrl[p].abort();
  const c = ctrl[p] = new AbortController(), signal = c.signal;
  const info = { out: [], warn: [], err: '' };
  const set = (k, v) => A.setAuto(p, k, v);
  A.setBusy(p, true);
  try {
    const ap = await airport(icao);
    if (signal.aborted) return;
    const lat = LAT.find(icao), tz = ap.tz || 'UTC', t = Math.floor(when / 1000);
    set('elev', Math.round(ap.elev));
    info.out.push(`${landing ? 'Arrival' : 'Takeoff'} ${localHM(when, tz)} ${ap.tz ? 'local' : 'UTC'}`);
    info.out.push(`elevation ${ap.elevSrc}`);
    if (ap.mv === null) info.warn.push('no magnetic variation – wind left in true degrees');

    const hours = Math.min(48, Math.max(3, Math.ceil((Date.now() - when) / 3600000) + 2));
    // The forecast model is the slowest source and only needed when no METAR covers the time: do not wait for it otherwise.
    // Its connections sometimes hang and then answer at once on a second try: 4 s limit, one retry.
    const omGet = () => jget(`${OM}${OMH}&latitude=${ap.lat}&longitude=${ap.lon}&start_date=${day(when - 86400000)}&end_date=${day(when + 86400000)}`, signal, 4000);
    const omP = soft(omGet().catch(omGet), null);
    const [taf, ...obs] = await Promise.all([
      ap.taf ? soft(jget(`/api/aw/taf?ids=${ap.taf}`, signal).then((x) => x[0] || null), null) : null,
      ...ap.st.map(([id]) => soft(jget(`/api/aw/metar?ids=${id}&hours=${hours}`, signal), [])),
    ]);
    if (signal.aborted) return;
    // first listed station with an observation near the requested time, else the first with any
    let si = obs.findIndex((m) => W.nearestMetar(m, t));
    if (si < 0) si = obs.findIndex((m) => m && m.length);
    const st = si >= 0 ? ap.st[si] : null;
    const om = st && W.nearestMetar(obs[si], t) ? null : await omP;
    if (signal.aborted) return;
    const wx = W.pickWeather({ metars: st ? obs[si] : [], taf, om, t, unit: /^(US|CA)$/.test(ap.country) ? 'inHg' : 'hPa' });
    const from = (src) => src + (st && st[1] && /METAR/.test(src) ? ` from ${st[0]} (${st[1]} NM away)` : '');

    const wind = wx.wind, mv = ap.mv || 0;
    if (wind && typeof wind.dir === 'number') {
      set('wdir', Math.round(W.norm360(wind.dir + mv) / 10) * 10 || 360); set('wspd', wind.spd || 0); set('wgust', wind.gst || '');
    } else if (wind) { set('wdir', ''); set('wspd', wind.spd || 0); set('wgust', wind.gst || ''); }
    else info.warn.push('no wind data');
    if (wind) info.out.push(`wind: ${from(wind.src)}`);
    set('remarks', wx.raw ? wx.raw.replace(/^(METAR|SPECI)\s+/, '').replace(/\s+RMK.*$/, '') : '');
    if (wx.qnh) set('qnh', wx.qnh.v); else info.warn.push('no QNH data');
    if (wx.temp) set('oat', wx.temp.v); else info.warn.push('no temperature data');
    const other = [wx.temp, wx.qnh].find((x) => x && (!wind || x.src !== wind.src));
    if (other) info.out.push(`temp/QNH: ${from(other.src)}`);
    if (wx.qnh && /model/.test(wx.qnh.src)) info.warn.push('QNH is a forecast – confirm with ATIS');
    if (wx.wind && /not the requested time/.test(wx.wind.src)) info.warn.push('forecast service slow or unreachable – showing the latest METAR instead; ↻ refresh to retry');
    else if (!(wx.wind && wx.temp && wx.qnh)) info.warn.push('forecast service slow or unreachable – ↻ refresh to retry');

    // runways LAT allows here (for the landing sheet also the "full stop landing only" ones)
    const ends = ap.ends.filter((e) => W.rwyAllowed(lat, e.id, landing));
    let list = [];
    if (!ends.length) info.warn.push(ap.ends.length ? 'no authorized runway' : 'no runway data – enter the runway under “Edit”');
    else {
      const hasDir = wind && typeof wind.dir === 'number', calm = !(wind && wind.spd >= 3);
      list = ends.map((e) => ({ id: e.id, len: e.len, hdg: e.hdg, surf: e.surf, head: Math.round(hasDir ? W.headwind(wind.dir, wind.spd, e.hdgT) : 0) }));
      const best = list.slice().sort((a, b) => (calm ? b.len - a.len : (b.head - a.head) || (b.len - a.len)))[0];
      const pick = A.get(`${p}.pick`);
      const use = list.find((e) => e.id === pick) || best; // a runway the user chose stays chosen
      set('rwy', use.id); set('hdg', use.hdg); set('len', use.len); set('surf', use.surf);
    }
    A.setMeta(p, { info, ends: list, fkey: key, fat: Date.now() });
  } catch (e) {
    if (signal.aborted) return;
    info.err = /Failed to fetch|NetworkError|Load failed|aborted|HTTP 5/.test(e.message) ? 'Data service slow or unreachable – ↻ refresh to retry.' : e.message;
    A.setMeta(p, { info, fkey: undefined });
  } finally {
    if (ctrl[p] === c) { delete ctrl[p]; A.setBusy(p, false); }
  }
}

/* ---------- when to (re)load ---------- */
// Every sheet gets a key "airport|time". Only sheets whose key changed, or whose data is older than 30 min, reload.
const FRESH = 30 * 60000;
let plan = 0;
async function check(force) {
  const my = ++plan;
  const date = A.get('date'), time = A.get('time'), pts = A.points();
  if (A.get('mode') === 'result') return; // a calculated sheet never refetches
  if (offline || !date || !time || !pts[0] || !/^[A-Z0-9]{3,4}$/.test(pts[0].icao)) return;
  let tz;
  try { tz = (await airport(pts[0].icao)).tz || 'UTC'; } catch (e) { tz = 'UTC'; } // the run below reports the error
  if (my !== plan) return;
  let when = localToUtc(date, time, tz);
  pts.forEach(({ p, icao, landing }, i) => {
    if (i > 0) {
      const prev = pts[i - 1].p;
      when += ((parseFloat(A.pv(prev, 'dur')) || 0) + (landing ? 0 : parseFloat(A.pv(p, 'gnd')) || 0)) * 60000;
    }
    if (!/^[A-Z0-9]{3,4}$/.test(icao)) return;
    const key = `${icao}|${Math.round(when / 60000)}`;
    const have = A.get(`${p}.fkey`) === key && Date.now() - (A.get(`${p}.fat`) || 0) < FRESH;
    if (force !== p && (have || tried[p] === key)) return;
    tried[p] = key;
    run(p, icao, when, landing, key);
  });
}
let timer = null;
A.onChange = () => { clearTimeout(timer); timer = setTimeout(check, 800); };
A.refresh = (p) => { clearTimeout(timer); check(p); };
if (offline) A.points().forEach(({ p }) => A.setMeta(p, { info: { out: [], warn: [], err: 'Opened as a file: run `node server.js` and open http://localhost:8765 for automatic airport and weather data.' } }));
else check();
}
if (window.App) boot(); else window.addEventListener('app-ready', boot, { once: true });
})();
