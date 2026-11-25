// VFR navigation maths and B02 OFP time/fuel rules (LAT "overhead-overhead" method, B02 SEP-26).
// Pure functions. Classic script (works from file://) and CommonJS (node test.js).
// Courses and winds in the OFP are MAGNETIC. Distances NM, altitudes ft MSL, fuel USG, times whole minutes.
(function (root) {
'use strict';

const WMM = (typeof module !== 'undefined' && module.exports && typeof require === 'function') ? require('./vendor/wmm.js') : root.WMM;

const R_NM = 3440.065;                 // mean earth radius in NM
const RAD = Math.PI / 180, DEG = 180 / Math.PI;

const isNum = (v) => typeof v === 'number' && isFinite(v);
// Round to 0.1 with a tiny nudge so exact halves (6.35, 0.25) round up like a human would on the form.
const round1 = (x) => Math.round(x * 10 + 1e-9) / 10;
// Cruise time uses ceil, ignoring up to 6 s of rounding noise: B02 prints distance and GS to whole units, and
// its worked example (18 NM / 153 kt = 7.06 min -> :07, 19 NM / 141 kt = 8.09 min -> :08) only reconciles that way.
const EET_EPS = 0.1;

/* ---------------- angles ---------------- */
function norm360(d) { return ((d % 360) + 360) % 360; }
// a - b folded to -180..180 (so 002 vs 358 is +4, not -356)
function angDiff(a, b) { const d = norm360(a - b); return d > 180 ? d - 360 : d; }

/* ---------------- great circle (spherical earth) ---------------- */
function dist(a, b) {
  const la = a.lat * RAD, lb = b.lat * RAD, dl = (b.lon - a.lon) * RAD;
  const h = Math.sin((lb - la) / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dl / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}
function brg(a, b) {
  const la = a.lat * RAD, lb = b.lat * RAD, dl = (b.lon - a.lon) * RAD;
  return norm360(Math.atan2(Math.sin(dl) * Math.cos(lb), Math.cos(la) * Math.sin(lb) - Math.sin(la) * Math.cos(lb) * Math.cos(dl)) * DEG);
}
function along(a, b, frac) {
  const d = dist(a, b) / R_NM;
  if (d < 1e-12) return { lat: a.lat, lon: a.lon };
  const la = a.lat * RAD, lo = a.lon * RAD, lb = b.lat * RAD, ob = b.lon * RAD;
  const A = Math.sin((1 - frac) * d) / Math.sin(d), B = Math.sin(frac * d) / Math.sin(d);
  const x = A * Math.cos(la) * Math.cos(lo) + B * Math.cos(lb) * Math.cos(ob);
  const y = A * Math.cos(la) * Math.sin(lo) + B * Math.cos(lb) * Math.sin(ob);
  const z = A * Math.sin(la) + B * Math.sin(lb);
  return { lat: Math.atan2(z, Math.hypot(x, y)) * DEG, lon: Math.atan2(y, x) * DEG };
}
function mid(a, b) { return along(a, b, 0.5); }
function offset(p, brgDeg, nm) {
  const d = nm / R_NM, t = brgDeg * RAD, la = p.lat * RAD, lo = p.lon * RAD;
  const lat = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(t));
  const lon = lo + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(lat));
  return { lat: lat * DEG, lon: ((lon * DEG + 540) % 360) - 180 };
}
// Distance from p to the SEGMENT a-b (nearest endpoint when p is beyond either end).
function xtrack(p, a, b) {
  const dab = dist(a, b);
  if (dab < 1e-9) return dist(p, a);
  const dap = dist(a, p) / R_NM;
  const th = angDiff(brg(a, p), brg(a, b)) * RAD;
  const xt = Math.asin(Math.max(-1, Math.min(1, Math.sin(dap) * Math.sin(th))));
  const at = Math.atan2(Math.sin(dap) * Math.cos(th), Math.cos(dap)) * R_NM;     // signed along-track NM
  if (at < 0) return dist(p, a);
  if (at > dab) return dist(p, b);
  return Math.abs(xt) * R_NM;
}

/* ---------------- magnetic variation and courses ---------------- */
// East positive. date: Date (default now).
function variation(p, date) {
  const d = date instanceof Date ? date : (date ? new Date(date) : new Date());
  return WMM.declination(p.lat, p.lon, 0, WMM.decimalYear(d));
}
// MC = TC - East variation (TC 100 with 10 E -> MC 090). True course is taken at the leg midpoint.
function magCourse(a, b, date) {
  const m = mid(a, b);
  return Math.round(norm360(brg(m, b) - variation(m, date))) % 360;
}

/* ---------------- wind triangle ---------------- */
// mc magnetic course, tas kt, wdir magnetic wind FROM, wspd kt. heading = mc + wca.
// A wind from the right of track gives a positive WCA. All angle maths goes through angDiff, so 358/002 wraps correctly.
function windTriangle({ mc, tas, wdir, wspd }) {
  if (!isNum(mc) || !isNum(tas) || tas <= 0) return { error: 'wind' };
  const ws = isNum(wspd) ? wspd : 0, wd = isNum(wdir) ? wdir : mc;
  const wa = angDiff(wd, mc) * RAD;                 // wind direction relative to course
  const cross = ws * Math.sin(wa);
  if (Math.abs(cross) >= tas) return { error: 'wind' };
  const wcaRad = Math.asin(cross / tas);
  const gs = tas * Math.cos(wcaRad) - ws * Math.cos(wa);
  if (!(gs > 0)) return { error: 'wind' };
  const wca = Math.round(wcaRad * DEG);
  return { wca: wca === 0 ? 0 : wca, hdg: norm360(mc + wca), gs: Math.round(gs) };
}

/* ---------------- B02 time and fuel rules ---------------- */
// Cruise EET in whole minutes, always rounded up (B02 p79: "8 NM / 147 kt = 3.3 -> :04").
function eet(distNm, gs) { return Math.max(0, Math.ceil(distNm / gs * 60 - EET_EPS)); }

// Climb additional time/fuel (B02 p71-72): climb height to the nearest 1000 ft, +1 min and +0.5 gal per 2000 ft
// (minutes rounded up, fuel pro rata). Descents add nothing. gal is rounded to 0.1 (rawGal keeps the exact figure).
function climbAdd(fromFt, toFt) {
  const d = Math.round((toFt - fromFt) / 1000) * 1000;
  if (!(d > 0)) return { min: 0, gal: 0, rawGal: 0 };
  return { min: Math.ceil(d / 2000), gal: round1(d / 2000 * 0.5), rawGal: d / 2000 * 0.5 };
}

// Approach additional time (B02 p80-81): +10 first arrival incl. first touch-down, +5 per further pattern
// (touch-and-go, and the final pattern to a full stop), +10 per full-stop taxi-back after the first touch-down,
// plus airwork minutes. +0.5 gal for the first taxi-back. The cruise-FF fuel for `min` is added by the caller.
// Airwork alone (no landing) adds only its minutes.
function pattern({ touchGo = 0, taxiBack = 0, fullStop = false, airwork = 0 } = {}) {
  const tg = Math.max(0, touchGo | 0), tb = Math.max(0, taxiBack | 0), aw = Math.max(0, airwork || 0);
  const fiveKind = tg + (fullStop ? 1 : 0);          // patterns costing +5
  let min = aw;
  if (fiveKind + tb > 0) min += fiveKind > 0 ? 10 + 5 * (fiveKind - 1) + 10 * tb : 10 + 10 * (tb - 1);
  return { min, gal: tb > 0 ? 0.5 : 0 };
}

// MSA: highest elevation rounded up to the next 500 ft, plus 1000 ft (4512 -> 5000 -> 6000).
function msa(maxElevFt) { return Math.ceil(maxElevFt / 500) * 500 + 1000; }

// Top of climb: from `fromFt` (1000 ft AGL) to `toFt` at 105 kt and 500 fpm.
function tocNm(fromFt, toFt) { return Math.max(0, (toFt - fromFt) / 500) * 105 / 60; }
// Top of descent (B02 p91): (altitude to lose / 1000) x 3 + 5 NM.
function todNm(cruiseFt, tpaFt) { return Math.max(0, (cruiseFt - tpaFt) / 1000) * 3 + 5; }

/* ---------------- semicircular altitudes ---------------- */
// Courses 000-179: odd thousands + 500; 180-359: even thousands + 500. The rule applies above 3000 ft AGL.
function semicircularOk(mc, altFt, groundFt) {
  if (altFt - (groundFt || 0) <= 3000) return true;
  const k = Math.round((altFt - 500) / 1000);
  if (Math.abs(altFt - (k * 1000 + 500)) > 1e-6) return false;
  return norm360(mc) < 180 ? k % 2 === 1 : k % 2 === 0;
}
function semicircularAlts(mc, minFt, maxFt) {
  const east = norm360(mc) < 180, out = [];
  for (let k = Math.max(0, Math.ceil((minFt - 500) / 1000)); k * 1000 + 500 <= maxFt; k++) {
    if ((k % 2 === 1) === east) out.push(k * 1000 + 500);
  }
  return out;
}

// Glide reach (POH about 9:1, safety factor 0.8, no wind). Never below zero.
function glideReachNm(altFt, elevFt) { return Math.max(0, (altFt - elevFt) / 6076 * 9 * 0.8); }

/* ---------------- time formatting ---------------- */
function fmtEet(min) {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60), r = m % 60;
  return (h ? h : '') + ':' + String(r).padStart(2, '0');
}
function addHHMM(hhmm, min) {
  const s = String(hhmm || '').replace(/\D/g, '').padStart(4, '0');
  const t = ((parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(2, 4), 10) + Math.round(min)) % 1440 + 1440) % 1440;
  return String(Math.floor(t / 60)).padStart(2, '0') + String(t % 60).padStart(2, '0');
}

/* ---------------- the OFP ---------------- */
// computeOfp rounding decisions (derived from the B02 worked example, SEP-26 pp. 60-85):
//  * Cruise EET = ceil(dist / GS * 60) (see EET_EPS above). Leg EET = cruise EET + climb minutes + extra minutes.
//    A fixed-time ATO leg (row.fixed) uses its fixed minutes and skips the wind triangle and the climb add.
//  * Leg fuel = round1( round1(cruiseEET / 60 * row.ff) + exact climb gal + extra min / 60 * cruiseFf + extra gal ).
//    The cruise part is rounded first, from the WHOLE-minute EET (B02 p81: leg fuel 1.5, approach fuel 5.3, leg 6.8;
//    7 min x 12.7 = 1.48 -> 1.5, so cruise fuel is on the rounded-up minutes, not the 6.81 raw minutes). Climb and
//    approach/airwork fuel are added unrounded and the SUM is rounded once (Motown: 1.7 + 0.25 + 6.35 = 8.3 as printed;
//    rounding each part gives 8.4). Each row uses its own altitude's FF (row.ff); approach and airwork use cruiseFf.
//  * Pl. Fuel = takeoff fuel minus the running sum of the rounded leg fuels, to 0.1.
//  * Min. Fuel: destination row = round1(reserveMin / 60 * cruiseFf); each row above = next row's Min. Fuel + next
//    row's leg fuel.
//  * Known B02 inconsistencies (the example is not reproducible by pure maths): the GS/WCA printed come from an E6B
//    and differ by 1-4 kt / 1 deg from 250/10 maths, and the 4-min Tire Farm leg is printed 0.9 gal (12.7 GPH would
//    give 0.8; 12.9 GPH gives 0.9). The test therefore feeds per-row winds/FF that reproduce the printed rows.
// A leg whose wind triangle fails keeps `error: 'wind'` with null gs/eet/fuel; it adds nothing to the totals and
// totals.incomplete is set.
function computeOfp(input) {
  const cruiseFf = input.cruiseFf;
  const out = { rows: [], totals: { eet: 0, trip: 0 }, reserveGal: 0 };
  let cumMin = 0, cumFuel = 0, incomplete = false;
  (input.rows || []).forEach((r) => {
    const ff = isNum(r.ff) ? r.ff : cruiseFf;
    const o = Object.assign({}, r, { wca: null, gs: null, eet: null, pto: null, legFuel: null, plFuel: null, minFuel: null,
      climb: { min: 0, gal: 0 }, extra: { min: 0, gal: 0 }, how: {} });
    const how = o.how;
    let cruiseMin = null;
    if (r.fixed && isNum(r.fixed.min)) {
      cruiseMin = r.fixed.min;
      how.eet = 'ATO procedure: ' + fmtEet(cruiseMin) + (isNum(r.fixed.nm) ? ' for ' + r.fixed.nm + ' NM' : '');
    } else {
      const t = windTriangle({ mc: r.mc, tas: r.tas, wdir: r.wdir, wspd: r.wspd });
      if (t.error) {
        o.error = t.error;
        how.gs = 'Wind too strong for ' + r.tas + ' kt TAS on MC ' + r.mc;
        incomplete = true;
        out.rows.push(o);
        return;
      }
      o.wca = t.wca; o.gs = t.gs;
      cruiseMin = eet(r.dist, t.gs);
      how.wca = 'asin(' + r.wspd + ' kt x sin(wind angle ' + Math.round(angDiff(r.wdir, r.mc)) + ') / ' + r.tas + ' kt TAS) = ' + (t.wca > 0 ? '+' : '') + t.wca + '°';
      how.gs = r.tas + ' kt TAS, wind ' + String(Math.round(r.wdir)).padStart(3, '0') + '/' + r.wspd + ', WCA ' + t.wca + '° = ' + t.gs + ' kt';
      how.eet = r.dist + ' NM / ' + t.gs + ' kt = ' + (r.dist / t.gs * 60).toFixed(1) + ' min → ' + fmtEet(cruiseMin);
    }
    // climb add
    let climbGal = 0;
    if (!r.fixed && isNum(r.prevAlt) && isNum(r.alt)) {
      const c = climbAdd(r.prevAlt, r.alt);
      o.climb = { min: c.min, gal: c.gal };
      climbGal = c.rawGal;
    }
    // approach / airwork remarks
    let extraGal = 0;
    if (r.pattern) {
      const p = pattern(r.pattern);
      extraGal = p.min / 60 * cruiseFf + p.gal;
      o.extra = { min: p.min, gal: round1(extraGal) };
    }
    // Optional fixed extra minutes (ATO rule, e.g. Power Plant DEP into KGEU +10): charged at cruise FF, no remark.
    if (isNum(r.extraMin) && r.extraMin > 0) {
      extraGal += r.extraMin / 60 * cruiseFf;
      o.extra = { min: o.extra.min + r.extraMin, gal: round1(extraGal) };
      how.extra = (r.extraHow || 'Extra') + ': +' + r.extraMin + ' min at ' + cruiseFf + ' GPH';
    }
    const totalMin = cruiseMin + o.climb.min + o.extra.min;
    o.eet = totalMin;
    const cruiseFuel = round1(cruiseMin / 60 * ff);
    const legFuel = round1(cruiseFuel + climbGal + extraGal);
    o.legFuel = legFuel;
    cumMin += totalMin; cumFuel += legFuel;
    o.pto = addHHMM(input.toTime, cumMin);
    o.plFuel = round1(input.takeoffFuel - cumFuel);
    if (o.climb.min || o.extra.min) {
      how.eet += ' + ' + fmtEet(o.climb.min + o.extra.min) + (o.climb.min ? ' climb' : '') + (o.climb.min && o.extra.min ? ' +' : '') + (o.extra.min ? ' remarks' : '') + ' = ' + fmtEet(totalMin);
    }
    how.legFuel = fmtEet(cruiseMin) + ' x ' + ff + ' GPH = ' + cruiseFuel.toFixed(1)
      + (o.climb.gal ? ' + ' + o.climb.gal.toFixed(1) + ' climb' : '')
      + (o.extra.gal ? ' + ' + o.extra.gal.toFixed(1) + ' remarks' : '') + ' = ' + legFuel.toFixed(1);
    how.plFuel = input.takeoffFuel.toFixed(1) + ' - ' + round1(cumFuel).toFixed(1) + ' burned = ' + o.plFuel.toFixed(1);
    out.rows.push(o);
  });
  // minimum fuel, working upward from the destination
  const rows = out.rows;
  const reserve = round1((input.reserveMin || 0) / 60 * cruiseFf);
  out.reserveGal = reserve;
  let below = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (below === null) { r.minFuel = reserve; r.how.minFuel = (input.reserveMin || 0) + ' min x ' + cruiseFf + ' GPH = ' + reserve.toFixed(1); }
    else {
      r.minFuel = round1(below.minFuel + (below.legFuel || 0));
      r.how.minFuel = below.minFuel.toFixed(1) + ' + ' + (below.legFuel || 0).toFixed(1) + ' next leg = ' + r.minFuel.toFixed(1);
    }
    below = r;
  }
  out.totals = { eet: rows.reduce((s, r) => s + (r.eet || 0), 0), trip: round1(rows.reduce((s, r) => s + (r.legFuel || 0), 0)) };
  if (incomplete) out.totals.incomplete = true;
  return out;
}

const Nav = { dist, brg, mid, along, offset, xtrack, norm360, angDiff, variation, magCourse, windTriangle, eet, climbAdd, pattern, msa,
  tocNm, todNm, semicircularOk, semicircularAlts, glideReachNm, computeOfp, fmtEet, addHHMM };
if (typeof module !== 'undefined' && module.exports) module.exports = Nav; else root.Nav = Nav;
})(this);
