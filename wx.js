// Weather selection logic for the autofill: which source answers for the requested time, QNH, runways.
// Pure functions, no network. Classic script (browser global Wx) and CommonJS (node test.js).
(function (root) {
'use strict';

const HR = 3600;
// aviationweather magdec "05W" -> +5 (west adds to true), "12E" -> -12
function magVar(s) { const m = /^(\d+)([EW])$/.exec(s || ''); return m ? (m[2] === 'W' ? 1 : -1) * parseInt(m[1], 10) : null; }
const norm360 = (d) => ((Math.round(d) % 360) + 360) % 360 || 360;

// Both ends of every runway. hdgT = true course, hdg = magnetic (what the form's heading field holds).
function runwayEnds(ap) {
  const mv = magVar(ap.magdec) || 0, out = [];
  (ap.runways || []).forEach((r) => {
    const len = parseInt(String(r.dimension).split('x')[0], 10);
    const surf = /^[ACB]/i.test(r.surface || '') ? 'paved' : 'dry';
    String(r.id).split('/').forEach((end, i) => {
      const m = /^(\d{1,2})([LRC]?)$/.exec(end.trim());
      if (!m) return;
      const hasAl = typeof r.alignment === 'number';
      const hdgT = hasAl ? (r.alignment + 180 * i) % 360 : m[1] * 10 - mv; // no alignment published: number is magnetic
      out.push({ id: end.trim(), len, surf, hdgT, hdg: norm360(hdgT + mv) });
    });
  });
  return out;
}

// Headwind component, true wind vs true runway course.
const headwind = (dirT, spd, hdgT) => spd * Math.cos((dirT - hdgT) * Math.PI / 180);

// Reduce station pressure (hPa) at elevM metres to sea level with the ISA lapse rate (QNH definition).
const qnhFromSurface = (hPa, elevM) => hPa * Math.pow(1 - 0.0065 * elevM / 288.15, -5.255);

function altimeter(raw) {
  let m = /\bA(\d{4})\b/.exec(raw || '');
  if (m) return { v: parseInt(m[1], 10) / 100, unit: 'inHg' };
  m = /\bQ(\d{4})\b/.exec(raw || '');
  return m ? { v: parseInt(m[1], 10), unit: 'hPa' } : null;
}

function nearestMetar(list, t, maxSec = HR) {
  let best = null;
  (list || []).forEach((m) => { if (Math.abs(m.obsTime - t) <= maxSec && (!best || Math.abs(m.obsTime - t) < Math.abs(best.obsTime - t))) best = m; });
  return best;
}

function tafAt(taf, t) {
  if (!taf || t < taf.validTimeFrom || t >= taf.validTimeTo) return null;
  const c = (taf.fcsts || []).filter((f) => f.timeFrom <= t && t < f.timeTo && f.wspd != null);
  const base = c.filter((f) => !/TEMPO|PROB/.test(f.fcstChange || '') && !f.probability);
  return (base.length ? base : c).sort((a, b) => b.timeFrom - a.timeFrom)[0] || null;
}

// Open-Meteo hourly series at time t (unix s), linear between hours. circ: wind direction.
function interpHourly(om, key, t, circ) {
  const h = om && om.hourly, ts = h && h.time, vs = h && h[key];
  if (!ts || !vs) return null;
  const i = ts.findIndex((x, k) => x <= t && (k === ts.length - 1 ? t === x : t < ts[k + 1]));
  if (i < 0 || vs[i] == null) return null;
  const j = i + 1;
  if (j >= ts.length || vs[j] == null || ts[j] === ts[i]) return vs[i];
  const f = (t - ts[i]) / (ts[j] - ts[i]);
  if (circ) { const d = ((vs[j] - vs[i] + 540) % 360) - 180; return (vs[i] + d * f + 360) % 360; }
  return vs[i] + (vs[j] - vs[i]) * f;
}

// A gust only counts when it is 10+ kt above the mean wind (METAR convention); drops model noise.
const gustOrNull = (spd, gst) => (gst != null && gst - spd >= 10 ? Math.round(gst) : null);

const hhmm = (sec) => new Date(sec * 1000).toISOString().slice(11, 16) + 'Z';

// Choose the best available weather for time t (unix s).
// metars: recent METARs (newest data first or any order); taf: single TAF or null; om: Open-Meteo response or null.
// unit: QNH unit for forecasts ('inHg' | 'hPa'). Returns {wind, temp, qnh} each {…, src} or null.
function pickWeather({ metars, taf, om, t, unit }) {
  const m = nearestMetar(metars, t);
  if (m) {
    const src = `METAR ${hhmm(m.obsTime)}`, q = altimeter(m.rawOb) || (m.altim ? { v: m.altim, unit: 'hPa' } : null);
    return {
      raw: m.rawOb,
      wind: typeof m.wspd === 'number' ? { dir: m.wdir, spd: m.wspd, gst: m.wgst || null, src } : null,
      temp: typeof m.temp === 'number' ? { v: Math.round(m.temp), src } : null,
      qnh: q && { ...q, src }
    };
  }
  const mode = t > Date.now() / 1000 ? 'forecast' : 'model analysis';
  let wind = null;
  const f = tafAt(taf, t);
  if (f) wind = { dir: f.wdir, spd: f.wspd, gst: f.wgst || null, src: `TAF issued ${hhmm(Date.parse(taf.issueTime) / 1000)}` };
  else {
    const spd = interpHourly(om, 'wind_speed_10m', t), dir = interpHourly(om, 'wind_direction_10m', t, true);
    if (spd !== null && dir !== null) wind = { dir: Math.round(dir), spd: Math.round(spd), gst: gustOrNull(spd, interpHourly(om, 'wind_gusts_10m', t)), src: `model ${mode} (GFS/HRRR)` };
  }
  const tp = interpHourly(om, 'temperature_2m', t), sp = interpHourly(om, 'surface_pressure', t);
  const hpa = sp === null ? null : qnhFromSurface(sp, om.elevation || 0);
  const qnh = hpa === null ? null : { v: unit === 'inHg' ? Math.round(hpa * 0.0295300 * 100) / 100 : Math.round(hpa), unit, src: `model ${mode}` };
  const out = { wind, temp: tp === null ? null : { v: Math.round(tp), src: `model ${mode}` }, qnh };
  // Model unreachable: fall back to the newest METAR and say it is not for the requested time.
  const last = (metars || []).slice().sort((a, b) => b.obsTime - a.obsTime)[0];
  if (last && !(out.wind && out.temp && out.qnh)) {
    const src = `METAR ${hhmm(last.obsTime)} (not the requested time)`, q = altimeter(last.rawOb);
    out.wind = out.wind || (typeof last.wspd === 'number' ? { dir: last.wdir, spd: last.wspd, gst: last.wgst || null, src } : null);
    out.temp = out.temp || (typeof last.temp === 'number' ? { v: Math.round(last.temp), src } : null);
    out.qnh = out.qnh || (q && { ...q, src });
  }
  return out;
}

// LAT approved-airport limits (airports.js entry) for one takeoff. rwy: runway end id, head: headwind kt (negative = tailwind).
const rwyKey = (id) => String(id || '').trim().toUpperCase().replace(/^0+/, '');
function rwyAllowed(apt, id) {
  const l = (apt && apt.lim) || {}, k = rwyKey(id);
  return !(l.noTO || []).includes(k) && !(l.noUse || []).includes(k);
}
function latChecks(apt, { rwy, tow, oat, head }) {
  const w = [], l = (apt && apt.lim) || {}, k = rwyKey(rwy), n = apt && apt.id;
  if (!apt) return w;
  if (k && (l.noUse || []).includes(k)) w.push(`${n}: Rwy ${rwy} not authorized for LAT`);
  else if (k && (l.noTO || []).includes(k)) w.push(`${n}: Rwy ${rwy} not authorized for takeoff (full stop landing only)`);
  if (l.mtom && tow > l.mtom) w.push(`${n}: T/O mass ${Math.round(tow)} lb exceeds LAT MTOM ${l.mtom} lb`);
  if (l.maxTemp != null && oat > l.maxTemp) w.push(`${n}: OAT ${oat} °C above LAT max ${l.maxTemp} °C for T/O`);
  const tw = l.tw ? (l.tw[k] !== undefined ? l.tw[k] : l.tw['*']) : undefined;
  if (tw !== undefined && head < 0 && -head > tw + 1e-9) w.push(`${n}: tailwind ${Math.round(-head)} kt exceeds LAT max ${tw} kt${k ? ' for Rwy ' + rwy : ''}`);
  return w;
}

const Wx = { magVar, runwayEnds, headwind, qnhFromSurface, altimeter, nearestMetar, tafAt, interpHourly, gustOrNull, pickWeather, hhmm, norm360, rwyKey, rwyAllowed, latChecks };
if (typeof module !== 'undefined' && module.exports) module.exports = Wx; else root.Wx = Wx;
})(this);
