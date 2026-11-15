// Airport + weather autofill. Needs `node server.js` (relays NOAA aviationweather.gov and NWS).
(function () {
'use strict';
const P = window.Perf;
const el = (id) => document.getElementById(id);
const setv = (id, v) => { const e = el(id); if (!e) return; e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); };
async function jget(u) {
  const r = await fetch(u);
  if (!r.ok) throw new Error(`${u.split('?')[0]} → HTTP ${r.status}`);
  return r.json();
}

// "05W" -> +5 (west adds), "12E" -> -12
function magVar(s) { const m = /^(\d+)([EW])$/.exec(s || ''); return m ? (m[2] === 'W' ? 1 : -1) * parseInt(m[1], 10) : null; }
function runwayEnds(ap) {
  const out = [];
  (ap.runways || []).forEach((r) => {
    const len = parseInt(String(r.dimension).split('x')[0], 10);
    const surf = /^[ACB]/i.test(r.surface || '') ? 'paved' : 'dry';
    String(r.id).split('/').forEach((end) => {
      const m = /^(\d{1,2})([LRC]?)$/.exec(end.trim());
      if (m) out.push({ id: end.trim(), hdg: parseInt(m[1], 10) * 10, len, surf });
    });
  });
  return out;
}
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
function tafAt(taf, sec) {
  const c = (taf.fcsts || []).filter((f) => f.timeFrom <= sec && sec < f.timeTo && f.wspd != null);
  const base = c.filter((f) => !/TEMPO|PROB/.test(f.fcstChange || '') && !f.probability);
  return (base.length ? base : c).sort((a, b) => b.timeFrom - a.timeFrom)[0];
}
function altimeter(raw) {
  let m = /\bA(\d{4})\b/.exec(raw || '');
  if (m) return parseInt(m[1], 10) / 100;
  m = /\bQ(\d{4})\b/.exec(raw || '');
  return m ? parseInt(m[1], 10) : null;
}
const localHM = (ms, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
// NWS gridded forecast: value of a time series (validTime "start/PT3H") at a given moment
function seriesAt(series, when) {
  for (const v of (series && series.values) || []) {
    const [start, dur] = v.validTime.split('/');
    const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?)?$/.exec(dur);
    const ms = m ? ((+m[1] || 0) * 24 + (+m[2] || 0)) * 3600000 : 3600000;
    const s = Date.parse(start);
    if (s <= when && when < s + ms) return v.value;
  }
  return null;
}
const KT = 0.539957; // km/h -> kt
async function gridAt(path, when) {
  const p = (await jget('/api/nws/' + path)).properties;
  const spd = seriesAt(p.windSpeed, when), gst = seriesAt(p.windGust, when);
  return {
    temp: seriesAt(p.temperature, when), dir: seriesAt(p.windDirection, when),
    spd: spd === null ? null : Math.round(spd * KT), gst: gst === null || Math.round(gst * KT) <= Math.round(spd * KT) ? null : Math.round(gst * KT)
  };
}
const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16) + 'Z';

async function run(box, depWhen) {
  const p = box.dataset.p, land = box.dataset.land === '1';
  const k = (n) => p + (land ? 'l_' : '') + n;
  const stat = box.querySelector('.fstat'), sel = box.querySelector('.rsel');
  if (location.protocol === 'file:') { stat.textContent = 'This page was opened as a file. Run `node server.js` in the project folder, then open http://localhost:8765 in your browser.'; return null; }
  const log = [];
  const say = (t) => { log.push(t); stat.textContent = log.join('\n'); };
  stat.textContent = 'Fetching…'; sel.hidden = true;
  const icao = (el(k('apt')).value || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{3,4}$/.test(icao)) { stat.textContent = 'Enter the ICAO code first (e.g. KSEF).'; return null; }
  try {
    const ap = (await jget(`/api/aw/airport?ids=${icao}&format=json`))[0];
    if (!ap) throw new Error('Airport not found: ' + icao);
    const elevFt = Math.round(ap.elev * 3.28084);
    setv(k('elev'), elevFt);
    say(`${ap.name.trim()} · elev ≈ ${elevFt} ft (NOAA gives whole metres, ±3 ft – check chart)`);
    const mv = magVar(ap.magdec);
    if (mv === null) say('No magnetic variation available – wind left in true degrees.');

    // time zone + hourly forecast grid (US only)
    let tz = null, gridPath = null;
    try {
      const pt = (await jget(`/api/nws/points/${ap.lat},${ap.lon}`)).properties;
      tz = pt.timeZone; gridPath = pt.forecastGridData && pt.forecastGridData.replace('https://api.weather.gov/', '');
    } catch (e) { say('Time zone lookup failed – time treated as UTC.'); }
    const date = el('date').value, tEl = el(k('time'));
    const typed = tEl.value && tEl.value !== tEl.dataset.auto; // user-entered time wins over the autofilled one
    let when = Date.now();
    if (typed && date) when = localToUtc(date, tEl.value, tz || 'UTC');
    else if (land && depWhen) when = depWhen + (parseFloat(el('dur').value) || 60) * 60000;
    if (!typed) { tEl.dataset.auto = localHM(when, tz); setv(k('time'), tEl.dataset.auto); }
    const sec = Math.floor(when / 1000), dtMin = (when - Date.now()) / 60000;
    say(`${land ? 'Arrival' : 'Departure'} ${tEl.value} ${tz || 'UTC'} = ${hhmm(when)}${typed || !land ? '' : ' (departure + flight time)'}`);

    const [metar] = await jget(`/api/aw/metar?ids=${icao}&format=json`).catch(() => []);
    const [taf] = await jget(`/api/aw/taf?ids=${icao}&format=json`).catch(() => []);
    let wind = null, src = '', grid = null;
    const near = Math.abs(dtMin) < 90;
    if (near && metar) { wind = { dir: metar.wdir, spd: metar.wspd, gst: metar.wgst }; src = `METAR ${hhmm(metar.obsTime * 1000)}`; }
    else {
      if (gridPath) { try { grid = await gridAt(gridPath, when); } catch (e) { /* no gridded forecast */ } }
      const f = taf && sec >= taf.validTimeFrom && sec < taf.validTimeTo ? tafAt(taf, sec) : null;
      if (f) { wind = { dir: f.wdir, spd: f.wspd, gst: f.wgst }; src = `TAF (issued ${hhmm(taf.issueTime ? Date.parse(taf.issueTime) : when)})`; }
      else if (grid && grid.dir !== null && grid.spd !== null) { wind = { dir: grid.dir, spd: grid.spd, gst: grid.gst }; src = `NWS forecast${taf ? ' (time outside TAF)' : ' (no TAF for ' + icao + ')'}`; }
      else if (metar) { wind = { dir: metar.wdir, spd: metar.wspd, gst: metar.wgst }; src = `METAR ${hhmm(metar.obsTime * 1000)}`; say('No forecast available for that time (NWS covers about 7 days, US only) – using current METAR wind.'); }
    }
    if (wind && typeof wind.dir === 'number') {
      const magDir = ((wind.dir + (mv || 0)) % 360 + 360) % 360 || 360;
      const md = Math.round(magDir / 10) * 10 || 360;
      setv(k('wdir'), md); setv(k('wspd'), wind.spd || 0); setv(k('wgust'), wind.gst || '');
      say(`Wind ${src}: ${String(wind.dir).padStart(3, '0')}°T/${wind.spd}${wind.gst ? 'G' + wind.gst : ''} kt → ${String(md).padStart(3, '0')}° magnetic`);
    } else if (wind) { setv(k('wdir'), ''); setv(k('wspd'), wind.spd || 0); setv(k('wgust'), wind.gst || ''); say(`Wind ${src}: variable ${wind.spd} kt – ${el('vrbWorst').checked ? 'worst case assumed (full tailwind and crosswind).' : 'no head/crosswind applied.'}`); }
    else say('No wind data found.');

    if (!land && metar && metar.rawOb) { setv(k('remarks'), metar.rawOb.replace(/^(METAR|SPECI)\s+/, '').replace(/\s+RMK.*$/, '')); }
    // QNH (current METAR only) and temperature
    const q = metar && altimeter(metar.rawOb);
    if (q) { setv(k('qnh'), q); say(`QNH ${q} from METAR ${hhmm(metar.obsTime * 1000)}${!near ? ' (current – not forecast)' : ''}`); }
    let temp = null;
    if (!near && grid && grid.temp !== null) { temp = Math.round(grid.temp); say(`Temp ${temp} °C from NWS forecast`); }
    if (temp === null && metar && typeof metar.temp === 'number') { temp = Math.round(metar.temp); say(`Temp ${temp} °C from current METAR`); }
    if (temp !== null) setv(k('oat'), temp);

    // runways
    const ends = runwayEnds(ap);
    if (!ends.length) { say('No runway data.'); return when; }
    const hw = (e) => { const w = P.windComponents(parseFloat(el(k('wdir')).value), parseFloat(el(k('wspd')).value), 0, e.hdg); return w ? w.head : 0; };
    const calm = !(parseFloat(el(k('wspd')).value) >= 3);
    ends.forEach((e) => { e.head = hw(e); });
    const best = ends.slice().sort((a, b) => (calm ? b.len - a.len : (b.head - a.head) || (b.len - a.len)))[0];
    sel.innerHTML = ends.map((e, i) => `<option value="${i}">RWY ${e.id} · ${e.len} ft · ${e.hdg}° · ${e.head >= 0 ? 'HW' : 'TW'} ${Math.abs(Math.round(e.head))}${e.surf === 'dry' ? ' · grass/other' : ''}</option>`).join('');
    const apply = (e) => {
      setv(k('rwy'), e.id); setv(k('hdg'), e.hdg); setv(k('len'), e.len); setv(k('surf'), e.surf);
    };
    sel.value = String(ends.indexOf(best)); sel.hidden = false; sel.onchange = () => apply(ends[+sel.value]);
    apply(best);
    say(`Runway ${best.id} selected (${calm ? 'longest, wind calm' : 'most headwind'}) – change in the list above if needed.`);
    if (land) say('Runway length is the full length – use LDA if displaced threshold.');
    return when;
  } catch (e) {
    const msg = /Failed to fetch|NetworkError|HTTP 404|Cross origin|access control|Load failed/.test(e.message) ? 'Cannot reach the data relay. Start it with `node server.js` and open http://localhost:8765.' : e.message;
    stat.innerHTML = log.map((l) => l.replace(/[<>&]/g, '')).join('\n') + `\n<span class="err">${msg.replace(/[<>&]/g, '')}</span>`;
    return null;
  }
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('.fbtn');
  if (b) run(b.closest('.fetch'));
  const g = e.target.closest('.gobtn');
  if (!g) return;
  const [dep, arr] = g.closest('.fetchall').querySelectorAll('.fetch');
  g.disabled = true;
  const when = await run(dep);
  if (when) await run(arr, when);
  g.disabled = false;
});
})();
