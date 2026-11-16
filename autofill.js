// Airport + weather autofill. Airport/METAR/TAF via our /api/aw relay (aviationweather.gov), forecasts from Open-Meteo.
// Which source answers for the requested time is decided in wx.js.
(function () {
'use strict';
const P = window.Perf, W = window.Wx;
const el = (id) => document.getElementById(id);
const setv = (id, v) => { const e = el(id); if (!e) return; e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); };
async function jget(u) {
  const r = await fetch(u);
  if (!r.ok) throw new Error(`${u.split('?')[0]} → HTTP ${r.status}`);
  return r.json();
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
const localHM = (ms, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
const OM = 'https://api.open-meteo.com/v1/forecast?hourly=temperature_2m,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m&models=gfs_seamless&wind_speed_unit=kn&timezone=auto&timeformat=unixtime&past_days=1&forecast_days=16';
const hhmm = (ms) => W.hhmm(ms / 1000);

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
    const ap = (await jget(`/api/aw/airport?ids=${icao}`))[0];
    if (!ap) throw new Error('Airport not found: ' + icao);
    const elevFt = Math.round(ap.elev * 3.28084);
    setv(k('elev'), elevFt);
    say(`${ap.name.trim()} · elev ≈ ${elevFt} ft (NOAA gives whole metres, ±3 ft – check chart)`);
    const mv = W.magVar(ap.magdec);
    if (mv === null) say('No magnetic variation available – wind left in true degrees.');

    // Forecast model (also gives the time zone). Failure is not fatal: METAR/TAF still work.
    const om = await jget(`${OM}&latitude=${ap.lat}&longitude=${ap.lon}`).catch(() => null);
    const tz = om && om.timezone;
    if (!tz) say('Forecast model unreachable – time treated as UTC, only METAR/TAF available.');
    const date = el('date').value, tEl = el(k('time'));
    const typed = tEl.value && tEl.value !== tEl.dataset.auto; // user-entered time wins over the autofilled one
    let when = Date.now();
    if (typed && date) when = localToUtc(date, tEl.value, tz || 'UTC');
    else if (land && depWhen) when = depWhen + (parseFloat(el('dur').value) || 60) * 60000;
    if (!typed) { tEl.dataset.auto = localHM(when, tz); setv(k('time'), tEl.dataset.auto); }
    say(`${land ? 'Arrival' : 'Departure'} ${tEl.value} ${tz || 'UTC'} = ${hhmm(when)}${typed || !land ? '' : ' (departure + flight time)'}`);

    const hours = Math.min(48, Math.max(3, Math.ceil((Date.now() - when) / 3600000) + 2));
    const metars = await jget(`/api/aw/metar?ids=${icao}&hours=${hours}`).catch(() => []);
    const taf = (await jget(`/api/aw/taf?ids=${icao}`).catch(() => []))[0] || null;
    const wx = W.pickWeather({ metars, taf, om, t: Math.floor(when / 1000), unit: /^(US|CA)$/.test(ap.country) ? 'inHg' : 'hPa' });

    const wind = wx.wind;
    if (wind && typeof wind.dir === 'number') {
      const md = Math.round(W.norm360(wind.dir + (mv || 0)) / 10) * 10 || 360;
      setv(k('wdir'), md); setv(k('wspd'), wind.spd || 0); setv(k('wgust'), wind.gst || '');
      say(`Wind ${wind.src}: ${String(wind.dir).padStart(3, '0')}°T/${wind.spd}${wind.gst ? 'G' + wind.gst : ''} kt → ${String(md).padStart(3, '0')}° magnetic`);
    } else if (wind) { setv(k('wdir'), ''); setv(k('wspd'), wind.spd || 0); setv(k('wgust'), wind.gst || ''); say(`Wind ${wind.src}: variable ${wind.spd} kt – ${el('vrbWorst').checked ? 'worst case assumed (full tailwind and crosswind).' : 'no head/crosswind applied.'}`); }
    else say('No wind data found.');

    if (!land && wx.raw) setv(k('remarks'), wx.raw.replace(/^(METAR|SPECI)\s+/, '').replace(/\s+RMK.*$/, ''));
    if (wx.qnh) { setv(k('qnh'), wx.qnh.v); say(`QNH ${wx.qnh.v} ${wx.qnh.unit} from ${wx.qnh.src}${/model/.test(wx.qnh.src) ? ' – forecast, confirm with ATIS' : ''}`); }
    else say('No QNH data found.');
    if (wx.temp) { setv(k('oat'), wx.temp.v); say(`Temp ${wx.temp.v} °C from ${wx.temp.src}`); }
    else say('No temperature data found.');

    // runways
    const ends = W.runwayEnds(ap);
    if (!ends.length) { say('No runway data.'); return when; }
    const hasDir = wind && typeof wind.dir === 'number', calm = !(wind && wind.spd >= 3);
    ends.forEach((e) => { e.head = hasDir ? W.headwind(wind.dir, wind.spd, e.hdgT) : 0; });
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
    const msg = /Failed to fetch|NetworkError|HTTP 404|Cross origin|access control|Load failed/.test(e.message) ? 'Cannot reach the weather service. Check your connection (locally: run `node server.js` and open http://localhost:8765).' : e.message;
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
