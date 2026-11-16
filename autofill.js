// Airport + weather autofill, one run per takeoff (leg). Airport/METAR/TAF via our /api/aw relay (aviationweather.gov),
// field elevation from FAA ADDS (feet, CORS-enabled), forecasts from Open-Meteo. Source choice per time: wx.js.
(function () {
'use strict';
const W = window.Wx, A = window.App, LAT = window.LAT_AIRPORTS;
const el = (id) => document.getElementById(id);
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
const ADDS = 'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/US_Airport/FeatureServer/0/query?outFields=IDENT,NAME,ELEVATION&returnGeometry=true&outSR=4326&f=json&where=';
async function faaAirport(ident) {
  const j = await jget(ADDS + encodeURIComponent(`IDENT='${ident.replace(/[^A-Z0-9]/g, '')}'`)).catch(() => null);
  const f = j && j.features && j.features[0];
  return f ? { elev: f.attributes.ELEVATION, name: f.attributes.NAME, lat: f.geometry && f.geometry.y, lon: f.geometry && f.geometry.x } : null;
}
const autoTime = {}; // leg -> time we filled in; anything else in the field was typed
const leg = (i, k) => A.leg(i, k);
const set = (i, k, v) => A.set(`L${i}.${k}`, v);

// Returns the takeoff time (UTC ms) so the next leg can follow on, or null on failure.
async function run(i, prevWhen) {
  const stat = el('fstat' + i), sel = el('rsel' + i);
  if (!stat) return null;
  if (location.protocol === 'file:') { stat.textContent = 'Opened as a file: run `node server.js` and open http://localhost:8765.'; return null; }
  const out = [], warn = [];
  const show = (err) => { stat.innerHTML = [...out, ...warn.map((w) => `<span class="note">${w}</span>`), err ? `<span class="err">${err}</span>` : ''].filter(Boolean).join(' · '); };
  const icao = A.stop(i), lat = LAT.find(icao);
  if (!/^[A-Z0-9]{3,4}$/.test(icao)) { show('Enter the ICAO code in the route first.'); return null; }
  stat.textContent = 'Fetching…'; sel.hidden = true;
  try {
    let ap = (await jget(`/api/aw/airport?ids=${icao}`).catch(() => []))[0];
    const ident = (ap && ap.faaId) || (lat && lat.id) || icao.replace(/^K(?=[A-Z]{3}$)/, '');
    const faa = await faaAirport(ident);
    if (!ap && !faa) throw new Error('Airport not found: ' + icao);
    if (!ap) ap = { name: faa.name, lat: faa.lat, lon: faa.lon, country: 'US', runways: [] }; // e.g. A39, 1AZ0: no aviationweather entry
    const elev = faa ? faa.elev : lat ? lat.elev : ap.elev * 3.28084;
    set(i, 'elev', Math.round(elev));
    out.push(`${(lat ? lat.name : ap.name).trim()} · elev ${Math.round(elev)} ft${faa ? ' (FAA)' : lat ? ' (LAT list)' : ''}`);
    if (!faa && !lat) warn.push('elevation from whole metres, ±3 ft – check chart');
    const mv = W.magVar(ap.magdec);
    if (mv === null) warn.push('no magnetic variation – wind left in true degrees');

    // Forecast model (also gives the time zone). Failure is not fatal: METAR/TAF still work.
    const om = await jget(`${OM}&latitude=${ap.lat}&longitude=${ap.lon}`).catch(() => null);
    const tz = om && om.timezone;
    if (!tz) warn.push('forecast model unreachable – time treated as UTC');
    const date = A.get('date'), tv = leg(i, 'time');
    const typed = i === 0 && tv && tv !== autoTime[i];
    let when = Date.now();
    if (typed && date) when = localToUtc(date, tv, tz || 'UTC');
    else if (i > 0 && prevWhen) when = prevWhen + ((parseFloat(leg(i - 1, 'dur')) || 0) + (parseFloat(leg(i, 'gnd')) || 0)) * 60000;
    if (!typed) { autoTime[i] = localHM(when, tz); set(i, 'time', autoTime[i]); }
    out.push(`T/O ${localHM(when, tz)} ${tz ? 'local' : 'UTC'}`);

    const hours = Math.min(48, Math.max(3, Math.ceil((Date.now() - when) / 3600000) + 2));
    const awOk = !!ap.icaoId;
    const metars = awOk ? await jget(`/api/aw/metar?ids=${icao}&hours=${hours}`).catch(() => []) : [];
    const taf = awOk ? (await jget(`/api/aw/taf?ids=${icao}`).catch(() => []))[0] || null : null;
    const wx = W.pickWeather({ metars, taf, om, t: Math.floor(when / 1000), unit: /^(US|CA)$/.test(ap.country) ? 'inHg' : 'hPa' });

    const wind = wx.wind;
    if (wind && typeof wind.dir === 'number') {
      const md = Math.round(W.norm360(wind.dir + (mv || 0)) / 10) * 10 || 360;
      set(i, 'wdir', md); set(i, 'wspd', wind.spd || 0); set(i, 'wgust', wind.gst || '');
    } else if (wind) { set(i, 'wdir', ''); set(i, 'wspd', wind.spd || 0); set(i, 'wgust', wind.gst || ''); }
    else warn.push('no wind data');
    if (wind) out.push(`wind ${wind.src}`);
    if (wx.raw) set(i, 'remarks', wx.raw.replace(/^(METAR|SPECI)\s+/, '').replace(/\s+RMK.*$/, ''));
    if (wx.qnh) set(i, 'qnh', wx.qnh.v); else warn.push('no QNH data');
    if (wx.temp) set(i, 'oat', wx.temp.v); else warn.push('no temperature data');
    const other = [wx.temp, wx.qnh].filter((x) => x && (!wind || x.src !== wind.src));
    if (other.length) out.push(`temp/QNH ${other[0].src}`);
    if (wx.qnh && /model/.test(wx.qnh.src)) warn.push('QNH is a forecast – confirm with ATIS');

    // runways: only ends LAT allows for takeoff
    const all = W.runwayEnds(ap), ends = all.filter((e) => W.rwyAllowed(lat, e.id));
    if (!ends.length) { warn.push(all.length ? 'no runway authorized for takeoff' : 'no runway data – enter runway manually'); show(); return when; }
    const hasDir = wind && typeof wind.dir === 'number', calm = !(wind && wind.spd >= 3);
    ends.forEach((e) => { e.head = hasDir ? W.headwind(wind.dir, wind.spd, e.hdgT) : 0; });
    const best = ends.slice().sort((a, b) => (calm ? b.len - a.len : (b.head - a.head) || (b.len - a.len)))[0];
    sel.innerHTML = ends.map((e, k) => `<option value="${k}">RWY ${e.id} · ${e.len} ft · ${e.hdg}° · ${e.head >= 0 ? 'HW' : 'TW'} ${Math.abs(Math.round(e.head))}${e.surf === 'dry' ? ' · grass/other' : ''}</option>`).join('');
    const apply = (e) => { set(i, 'rwy', e.id); set(i, 'hdg', e.hdg); set(i, 'len', e.len); set(i, 'surf', e.surf); };
    sel.value = String(ends.indexOf(best)); sel.hidden = false; sel.onchange = () => apply(ends[+sel.value]);
    apply(best);
    show();
    return when;
  } catch (e) {
    const msg = /Failed to fetch|NetworkError|HTTP 404|Cross origin|access control|Load failed/.test(e.message) ? 'Cannot reach the weather service. Check your connection (locally: run `node server.js`).' : e.message;
    show(msg.replace(/[<>&]/g, ''));
    return null;
  }
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('.fbtn');
  if (b) { const i = +b.dataset.leg; run(i, i ? autoWhen[i - 1] : null).then((w) => { autoWhen[i] = w; }); return; }
  const g = e.target.closest('#go');
  if (!g) return;
  g.disabled = true;
  let when = null;
  for (let i = 0; i < A.nLegs(); i++) { when = await run(i, when); autoWhen[i] = when; }
  g.disabled = false;
});
const autoWhen = {};
})();
