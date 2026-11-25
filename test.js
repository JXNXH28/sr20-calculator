const P = require('./perf.js');
let fail = 0;
const eq = (name, got, want, tol = 0.5) => {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) fail++;
  console.log((ok ? 'ok   ' : 'FAIL ') + name + ' got ' + got + ' want ' + want);
};
// exact grid points
const t = P.takeoff({ elev: 0, qnh: 29.92, oat: 0, tow: 3150 });
eq('TO 3150 SL 0C gr', t.tor, 1503); eq('TO 3150 SL 0C tot', t.tod, 2273);
const t2 = P.takeoff({ elev: 0, qnh: 29.92, oat: 0, tow: 2600 });
eq('TO 2600 SL 0C gr', t2.tor, 913);
// mid cell (SL,0..10C): average of 1503,1623
eq('TO interp temp', P.takeoff({ elev: 0, qnh: 29.92, oat: 5, tow: 3150 }).tor, 1563);
// mid weight
eq('TO weight 2875 uses 3150 table', P.takeoff({ elev: 0, qnh: 29.92, oat: 0, tow: 2875 }).tor, 1503);
eq('TO weight 2600 uses 2600 table', P.takeoff({ elev: 0, qnh: 29.92, oat: 0, tow: 2600 }).tor, 913);
eq('TO weight 2601 uses 3150 table', P.takeoff({ elev: 0, qnh: 29.92, oat: 0, tow: 2601 }).tor, 1503);
// THB examples
eq('PA 900 / 21C: ISA 13 -> DA 1860', P.densityAlt(900, 21), 1860);
eq('PA 829 / 21C -> DA 1789', P.densityAlt(829, 21), 1789);
const s = P.speedRow(3080); eq('VR 3080', s[1], 70); eq('VLOF 3080', s[2], 74);
// wind: 10 kt headwind -> -8.33%
eq('headwind 12kt', P.takeoff({ elev: 0, qnh: 29.92, oat: 0, tow: 3150, wdir: 360, wspd: 12, hdg: 360 }).tor, 1503 * 0.9);
// tailwind 4kt +20%
const tw = P.takeoff({ elev: 0, qnh: 29.92, oat: 0, tow: 3150, wdir: 180, wspd: 4, hdg: 360 });
eq('tailwind 4kt', tw.tor, 1503 * 1.2);
const tw2 = P.takeoff({ elev: 0, qnh: 29.92, oat: 0, tow: 3150, wdir: 180, wspd: 12, hdg: 360 });
console.log(tw2.warn.length ? 'ok   tailwind>10 warns' : 'FAIL tailwind warn'); if (!tw2.warn.length) fail++;
// variable wind -> worst case: full tailwind (4 kt = +20%) and full crosswind
const vr = P.takeoff({ elev: 0, qnh: 29.92, oat: 0, tow: 3150, wspd: 4, hdg: 360 });
eq('VRB tailwind 4kt', vr.tor, 1503 * 1.2); eq('VRB crosswind', vr.cross, 4);
const vg = P.landing({ elev: 0, qnh: 29.92, oat: 0, w: 3150, flaps: 100, wspd: 4, wgust: 8, hdg: 360 });
eq('VRB off: no wind effect', P.takeoff({ elev: 0, qnh: 29.92, oat: 0, tow: 3150, wspd: 4, hdg: 360, vrbWorst: false }).tor, 1503);
eq('VRB landing uses gust as tail', vg.head, -8);
// A/C
eq('A/C tod', P.takeoff({ elev: 0, qnh: 29.92, oat: 0, tow: 3150, ac: true }).tod, 2273 + 400);
// landing exact
const l = P.landing({ elev: 0, qnh: 29.92, oat: 0, w: 3150, flaps: 100 });
eq('Land 100 gr', l.gr, 809); eq('Land 100 tot', l.tot, 2557); eq('VREF 3150 f100', l.vref, 78);
eq('VTGT gust', P.landing({ elev: 0, qnh: 29.92, oat: 0, w: 3150, flaps: 100, wspd: 12, wgust: 20 }).vtgt, 82);
// ROC exact
eq('ROC 2875 uses 3150 table', P.takeoff({ elev: 0, qnh: 29.92, oat: 0, tow: 2875 }).roc, 816);
eq('ROC 2600 uses 2600 table', P.takeoff({ elev: 0, qnh: 29.92, oat: 0, tow: 2600 }).roc, 1109);
eq('ROC 3150 SL 0C', P.takeoff({ elev: 0, qnh: 29.92, oat: 0, tow: 3150 }).roc, 816);
// QNH hPa
eq('PA hPa', P.pressureAlt(1000, 1003), 1300);
// envelope
const ls = P.loadSheet({ bem: 2250, bemMom: 318, w1: 170, w2: 0, w3: 0, w4: 0, bag: 0, fuelTO: 40, fuelTrip: 20 });
console.log(JSON.stringify({ zfm: ls.zfm, tom: ls.tom, lm: ls.lm, mt: ls.mt, inside: ls.inside, warn: ls.warn }));
eq('TOM', ls.tom, 2250 + 170 + 240);
const bad = P.loadSheet({ bem: 2250, bemMom: 300, w1: 0, fuelTO: 0 });
console.log(bad.inside.zfm === false ? 'ok   outside detected' : 'FAIL outside'); if (bad.inside.zfm !== false) fail++;
// ---- weather selection (wx.js) ----
const W = require('./wx.js');
eq('QNH at sea level', W.qnhFromSurface(1013.25, 0), 1013.25, 0.01);
eq('QNH 18 ft field', W.qnhFromSurface(1020.7, 5.49), 1021.4, 0.1);
const sef = { magdec: '05W', runways: [{ id: '01/19', dimension: '5234x100', surface: 'A', alignment: 360 }, { id: '14/32', dimension: '4990x100', surface: 'A', alignment: 135 }] };
const re = W.runwayEnds(sef), mag = (id) => re.find((e) => e.id === id).hdg;
eq('rwy 01 magnetic', mag('01'), 5, 0); eq('rwy 19 magnetic', mag('19'), 185, 0);
eq('rwy 14 magnetic', mag('14'), 140, 0); eq('rwy 32 magnetic', mag('32'), 320, 0);
eq('headwind direct', W.headwind(135, 10, 135), 10, 0.01); eq('tailwind', W.headwind(315, 10, 135), -10, 0.01);
const T = 1800000000, ms = [{ obsTime: T - 3000, wdir: 30, wspd: 6, temp: 17, rawOb: 'METAR X A3020' }, { obsTime: T - 9000, wdir: 90, wspd: 1, temp: 10, rawOb: 'METAR X A3000' }];
eq('nearest metar', W.nearestMetar(ms, T).wdir, 30, 0);
eq('no metar beyond 60 min', W.nearestMetar(ms, T + 7200) === null ? 1 : 0, 1, 0);
const taf = { validTimeFrom: T, validTimeTo: T + 86400, issueTime: '2027-01-15T07:20:00Z', fcsts: [
  { timeFrom: T, timeTo: T + 86400, wdir: 20, wspd: 7, wgst: null },
  { timeFrom: T + 3600, timeTo: T + 7200, fcstChange: 'TEMPO', wdir: 200, wspd: 25, wgst: 40 }] };
eq('taf ignores TEMPO', W.tafAt(taf, T + 4000).wdir, 20, 0);
eq('taf outside validity', W.tafAt(taf, T + 90000) === null ? 1 : 0, 1, 0);
const om = { elevation: 18, hourly: { time: [T, T + 3600], wind_speed_10m: [10, 20], wind_direction_10m: [350, 30], wind_gusts_10m: [12, 35], temperature_2m: [10, 20], surface_pressure: [1000, 1000] } };
eq('interp speed', W.interpHourly(om, 'wind_speed_10m', T + 1800), 15, 0.01);
eq('interp dir wraps 360', W.interpHourly(om, 'wind_direction_10m', T + 1800, true), 10, 0.01);
eq('interp outside range', W.interpHourly(om, 'wind_speed_10m', T + 9999) === null ? 1 : 0, 1, 0);
eq('gust noise dropped', W.gustOrNull(10, 14) === null ? 1 : 0, 1, 0); eq('gust kept', W.gustOrNull(10, 22), 22, 0);
const future = Date.now() / 1000 + 86400, om2 = JSON.parse(JSON.stringify(om)); om2.hourly.time = [future, future + 3600];
const pObs = W.pickWeather({ metars: ms, taf, om, t: T, unit: 'inHg' });
console.log(pObs.wind.src.startsWith('METAR') ? 'ok   observed wins near METAR' : 'FAIL observed'); if (!pObs.wind.src.startsWith('METAR')) fail++;
eq('observed QNH inHg', pObs.qnh.v, 30.2, 0.001);
eq('metar obs time kept', pObs.wind.at, T - 3000, 0); eq('metar obs time on temp and qnh', pObs.temp.at === pObs.qnh.at && pObs.qnh.at === T - 3000 ? 1 : 0, 1, 0);
const pTaf = W.pickWeather({ metars: [], taf: { ...taf, validTimeFrom: future - 10, validTimeTo: future + 86400, fcsts: [{ timeFrom: future - 10, timeTo: future + 86400, wdir: 20, wspd: 7, wgst: null }] }, om: om2, t: future, unit: 'inHg' });
console.log(/^TAF/.test(pTaf.wind.src) ? 'ok   TAF wind when valid' : 'FAIL TAF'); if (!/^TAF/.test(pTaf.wind.src)) fail++;
eq('model temp with TAF', pTaf.temp.v, 10, 0); eq('model QNH inHg', pTaf.qnh.v, 29.59, 0.01);
const pMod = W.pickWeather({ metars: [], taf: null, om: om2, t: future + 1800, unit: 'hPa' });
console.log(/^model/.test(pMod.wind.src) ? 'ok   model wind without TAF' : 'FAIL model'); if (!/^model/.test(pMod.wind.src)) fail++;
eq('model has no obs time', pMod.wind.at === undefined && pMod.temp.at === undefined ? 1 : 0, 1, 0); eq('taf issue time kept', pTaf.wind.at, Date.parse(taf.issueTime) / 1000, 0);
eq('model wind speed', pMod.wind.spd, 15, 0); eq('model gust below threshold', pMod.wind.gst === null ? 1 : 0, 1, 0);
const pFb = W.pickWeather({ metars: ms, taf: null, om: null, t: future, unit: 'hPa' });
console.log(/not the requested time/.test(pFb.wind.src) ? 'ok   stale METAR flagged' : 'FAIL fallback'); if (!/not the requested time/.test(pFb.wind.src)) fail++;
// ---- multi-leg weights ----
const lw = P.legWeights(2500, 40, [{ trip: 10 }, { trip: 8 }, { trip: 5 }]);
eq('leg1 tow', lw.legs[0].tow, 2740); eq('leg2 tow', lw.legs[1].tow, 2680); eq('leg3 fuel', lw.legs[2].fuel, 22);
eq('load trip no refuel', lw.loadTrip, 23); eq('end fuel', lw.endFuel, 17); eq('landing mass', lw.lm, 2602);
const lr = P.legWeights(2500, 40, [{ trip: 10 }, { trip: 8, refuel: 50 }, { trip: 5 }]);
eq('refuel leg2 tow', lr.legs[1].tow, 2800); eq('after refuel leg3', lr.legs[2].fuel, 42); eq('load trip until refuel', lr.loadTrip, 10);
console.log(P.legWeights(2500, 10, [{ trip: 8 }, { trip: 8 }]).warn.length ? 'ok   fuel shortage warns' : 'FAIL fuel warn');
// ---- LAT airport limits ----
const LAT = require('./airports.js');
eq('LAT find KGYR', LAT.find('kgyr').elev, 969.1); eq('LAT 1AZ0 icao', LAT.find('1AZ0').icao === '1AZ0' ? 1 : 0, 1, 0);
const chk = (code, o, re) => { const w = W.latChecks(LAT.find(code), o); const ok = re ? w.some((x) => re.test(x)) : !w.length; if (!ok) fail++; console.log((ok ? 'ok   ' : 'FAIL ') + code + ' ' + JSON.stringify(o) + ' -> ' + JSON.stringify(w)); };
chk('FLG', { rwy: '21', tow: 2950, oat: 20, head: 0 }, /MTOM 2900/);
chk('FLG', { rwy: '21', tow: 2850, oat: 26, head: 0 }, /max 25/);
chk('PRC', { rwy: '21R', tow: 2800, oat: 20, head: 0 }, /not authorized for takeoff/);
chk('PRC', { rwy: '21L', tow: 2800, oat: 20, head: -4 });
chk('SOW', { rwy: '07', tow: 2800, oat: 20, head: -6 }, /tailwind 6 kt/);
chk('PAN', { rwy: '06', tow: 2800, oat: 20, head: -1 }, /max 0 kt/);
chk('SOW', { rwy: '04', tow: 2800, oat: 20, head: 0 }, /not authorized for LAT/);
chk('GYR', { rwy: '21', tow: 3100, oat: 45, head: -8 });
chk('PRC', { rwy: '21R', tow: 2800, oat: 20, head: 0, landing: true });
chk('SOW', { rwy: '04', tow: 2800, oat: 20, head: 0, landing: true }, /not authorized for LAT/);
eq('tz AZ', LAT.find('KGYR').tz === 'America/Phoenix' ? 1 : 0, 1, 0); eq('tz CA', LAT.find('KBLH').tz === 'America/Los_Angeles' ? 1 : 0, 1, 0);
eq('E63 wx station', LAT.find('E63').wx[0][0] === 'KGXF' ? 1 : 0, 1, 0);
// FAA runway polygon (Gila Bend 04/22)
const e63 = W.runwaysFromFaa([{ attributes: { DESIGNATOR: '04/22', LENGTH: 5200, COMP_CODE: 'ASPH' }, geometry: { rings: [[[-112.666431550359, 32.963926415666], [-112.680734322566, 32.9562486439002], [-112.680865656604, 32.9564225049171], [-112.666562868396, 32.964100291683], [-112.666431550359, 32.963926415666]]] } }], -10);
eq('E63 rwy 04 true', e63.find((e) => e.id === '04').hdgT, 57.4, 1); eq('E63 rwy 22 true', e63.find((e) => e.id === '22').hdgT, 237.4, 1);
eq('E63 rwy 04 magnetic', e63.find((e) => e.id === '04').hdg, 47, 1); eq('E63 length', e63[0].len, 5200, 0);
// ---- snapshot (canonical inputs) ----
const Sn = require('./snapshot.js');
const fp = (s) => JSON.stringify(Sn.sortKeys(Sn.canonical(s)));
const base = { date: '2026-11-18', time: '09:30', reg: 'n123ab', flight: 'D1_1', prep: '', bem: '2250', bemCg: 140.5, w1: '170', w2: '', bag: 18, fuelTO: '38.5', trim: 'T/O 0', vrbWorst: true, nR: 3, R0: 'kgyr', R1: 'KBXK', R2: 'KGYR',
  'L0.oat': '31', 'L0.rwy': '21', 'L0.wdir': '240', 'L0.wspd': 12, 'L0.wgust': 18, 'L0.qnh': 29.92, 'L0.info': { out: ['Takeoff 09:30 local', 'wind: METAR 1453Z'], warn: [], err: '' }, 'L0.fkey': 'x', 'L0.fat': 1, 'L0.ends': [{ id: '21' }], 'L0.pick': '21',
  'L1.oat': 25, 'D.oat': 20, 'D.qnh': 30, edited: { 'L0.oat': 1 }, mode: 'draft', calcId: 5 };
const chg = (o) => Object.assign({}, base, o);
const same = (name, a, b) => { const ok = fp(a) === fp(b); if (!ok) fail++; console.log((ok ? 'ok   ' : 'FAIL ') + name); };
const diff = (name, a, b) => { const ok = fp(a) !== fp(b); if (!ok) fail++; console.log((ok ? 'ok   ' : 'FAIL ') + name); };
const shuffled = {}; Object.keys(base).reverse().forEach((k) => { shuffled[k] = base[k]; });
same('snapshot key order', base, shuffled);
same('snapshot ignores bookkeeping', base, chg({ 'L0.fkey': 'y', 'L0.fat': 99, 'L0.ends': [], 'L0.pick': '03', edited: {}, mode: 'result', calcId: 9, calcAt: 'now', 'L1.fkey': 'z' }));
same('snapshot ignores observation times', base, chg({ 'L0.info': { out: ['Takeoff 09:30 local', 'wind: METAR 1453Z'], warn: [], err: '', obs: { wind: 1, temp: 2 } } }));
same('snapshot number strings', base, chg({ bem: 2250, w1: 170, 'L0.oat': 31, 'L0.wdir': 240, 'L0.wspd': '12', fuelTO: 38.5, w2: undefined }));
same('snapshot case and spaces', base, chg({ reg: ' N123AB ', R0: 'KGYR ', 'L0.rwy': '21 ' }));
same('snapshot default = explicit', base, chg({ 'L0.dur': 60, 'L0.trip': '15', 'D.slope': 0, 'L0.ac': false, 'L0.surf': 'paved' }));
diff('snapshot weight', base, chg({ w1: 171 }));
diff('snapshot fuel', base, chg({ fuelTO: 40 }));
diff('snapshot OAT', base, chg({ 'L0.oat': 32 }));
diff('snapshot wind', base, chg({ 'L0.wspd': 13 }));
diff('snapshot source', base, chg({ 'L0.info': { out: ['wind: METAR 1553Z'] } }));
diff('snapshot trip fuel', base, chg({ 'L0.trip': 20 }));
same('snapshot removed stop leaks nothing', chg({ nR: 2, R2: 'KGYR' }), chg({ nR: 2, R2: '', 'L1.oat': 99, 'L1.rwy': '04', 'L1.info': { out: ['wind: METAR 1'] } }));
{
  const two = Sn.canonical(chg({ nR: 2, 'L1.oat': 99 }));
  const leaks = Object.keys(two).filter((k) => /^L1\./.test(k) || k === 'R2');
  if (leaks.length) fail++; console.log((leaks.length ? 'FAIL ' : 'ok   ') + 'snapshot has no stale L1/R2 keys');
}
{
  const c = Sn.canonical(base), m = Sn.meta(base);
  const ok = m.route === 'KGYR-KBXK-KGYR' && m.reg === 'N123AB' && m.flight_date === '2026-11-18' && m.dep_time === '09:30'
    && !('edited' in c) && !('L0.fkey' in c) && c['L0.src'] === 'wind: METAR 1453Z' && c.bem === 2250 && !('w2' in c);
  if (!ok) fail++; console.log((ok ? 'ok   ' : 'FAIL ') + 'snapshot meta + shape ' + JSON.stringify(m));
  const rt = fp(Sn.fromCanonical(c)) === JSON.stringify(Sn.sortKeys(c));
  if (!rt) fail++; console.log((rt ? 'ok   ' : 'FAIL ') + 'snapshot round trip');
  const cl = Sn.canonical(chg({ bag: '', 'L0.dur': '' })), rt2 = fp(Sn.fromCanonical(cl)) === JSON.stringify(Sn.sortKeys(cl)) && !('bag' in cl) && !('L0.dur' in cl);
  if (!rt2) fail++; console.log((rt2 ? 'ok   ' : 'FAIL ') + 'snapshot round trip keeps cleared defaults');
}
same('snapshot sheetMode lat = absent', base, chg({ sheetMode: 'lat' }));
diff('snapshot sheetMode pair', base, chg({ sheetMode: 'pair' }));
{
  const cl = Sn.canonical(chg({ sheetMode: 'lat' })), cp = Sn.canonical(chg({ sheetMode: 'pair' }));
  const ok = !('sheetMode' in cl) && cp.sheetMode === 'pair' && Sn.fromCanonical(cp).sheetMode === 'pair' && Sn.fromCanonical(cl).sheetMode === 'lat'
    && fp(Sn.fromCanonical(cp)) === JSON.stringify(Sn.sortKeys(cp));
  if (!ok) fail++; console.log((ok ? 'ok   ' : 'FAIL ') + 'snapshot sheetMode round trip');
}
// per-leg landing mass (as in app.js legLm): ZFM + (fuel at takeoff - trip) x lb/USG; last leg = legWeights lm
{
  const lw2 = P.legWeights(2500, 40, [{ trip: 10 }, { trip: 8 }]);
  const legLm = (i, trip) => 2500 + (lw2.legs[i].fuel - trip) * P.LB_PER_USG;
  eq('leg1 landing mass', legLm(0, 10), 2500 + 30 * P.LB_PER_USG); eq('last leg landing mass = lm', legLm(1, 8), lw2.lm);
}
// ==== nav tests (OFP) ====
{
  const Nav = require('./nav.js');
  const tst = (name, ok, extra) => { if (!ok) fail++; console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok ? '' : ' ' + (extra || ''))); };
  eq('nav eet 8nm/147', Nav.eet(8, 147), 4, 0);
  eq('nav 4min leg fuel @12.9', Math.round(4 / 60 * 12.9 * 10) / 10, 0.9, 1e-9);
  const c1 = Nav.climbAdd(2700, 5500), c2 = Nav.climbAdd(5500, 6500), c3 = Nav.climbAdd(6500, 5500);
  eq('nav climb 2700-5500 min', c1.min, 2, 0); eq('nav climb 2700-5500 gal', c1.gal, 0.8, 1e-9);
  eq('nav climb 5500-6500 min', c2.min, 1, 0); eq('nav climb 5500-6500 gal', c2.gal, 0.3, 1e-9);
  eq('nav descent adds nothing', c3.min + c3.gal, 0, 0);
  eq('nav pattern 3 T&G + full stop min', Nav.pattern({ touchGo: 3, fullStop: true }).min, 25, 0);
  eq('nav pattern fuel 25 min @12.7', Math.round(25 / 60 * 12.7 * 10) / 10, 5.3, 1e-9);
  eq('nav taxi-back gal', Nav.pattern({ taxiBack: 1 }).gal, 0.5, 0);
  eq('nav pattern full stop only', Nav.pattern({ fullStop: true }).min, 10, 0);
  eq('nav pattern airwork only', Nav.pattern({ airwork: 30 }).min, 30, 0);
  eq('nav msa 4512', Nav.msa(4512), 6000, 0); eq('nav msa 4500', Nav.msa(4500), 5500, 0);
  eq('nav tod 6500->1600', Nav.todNm(6500, 1600), 19.7, 0.05);
  eq('nav toc 2700->6500', Nav.tocNm(3700, 6500), 6500 > 0 ? (2800 / 500) * 105 / 60 : 0, 1e-9);
  // wind triangle (B02 example winds; the E6B figures in B02 are rounded by hand, see computeOfp comment)
  eq('nav wca mc309 wind 240/10', Nav.windTriangle({ mc: 309, tas: 151, wdir: 240, wspd: 10 }).wca, -4, 0);
  eq('nav wca mc124 wind 250/10', Nav.windTriangle({ mc: 124, tas: 150, wdir: 250, wspd: 10 }).wca, 3, 0);
  const wrap = Nav.windTriangle({ mc: 358, tas: 150, wdir: 2, wspd: 20 });
  eq('nav wrap gs 358/002', wrap.gs, 130, 0); eq('nav wrap wca small', Math.abs(wrap.wca), 1, 0); eq('nav wrap hdg', wrap.hdg, 359, 0);
  const wrap2 = Nav.windTriangle({ mc: 350, tas: 150, wdir: 10, wspd: 20 });
  tst('nav wrap 350 vs wind 010 = 20 deg angle', wrap2.gs === 131 && wrap2.wca === 3, JSON.stringify(wrap2));
  eq('nav angDiff wrap', Nav.angDiff(2, 358), 4, 0); eq('nav angDiff wrap neg', Nav.angDiff(358, 2), -4, 0);
  tst('nav wind too strong -> error', Nav.windTriangle({ mc: 90, tas: 100, wdir: 0, wspd: 120 }).error === 'wind');
  tst('nav headwind > tas -> error', Nav.windTriangle({ mc: 90, tas: 100, wdir: 90, wspd: 120 }).error === 'wind');
  tst('nav semicircular east 5500', Nav.semicircularOk(90, 5500, 1000) === true);
  tst('nav semicircular west 5500 bad', Nav.semicircularOk(270, 5500, 1000) === false);
  tst('nav semicircular 359 @6500', Nav.semicircularOk(359, 6500, 1000) === true);
  tst('nav semicircular below 3000 AGL', Nav.semicircularOk(270, 3500, 1000) === true);
  tst('nav semicircular alts east', JSON.stringify(Nav.semicircularAlts(90, 4000, 9000)) === '[5500,7500]');
  tst('nav semicircular alts west', JSON.stringify(Nav.semicircularAlts(270, 4000, 9000)) === '[4500,6500,8500]');
  eq('nav glide reach', Nav.glideReachNm(6500, 1600), 4900 / 6076 * 9 * 0.8, 1e-9); eq('nav glide never negative', Nav.glideReachNm(1000, 2000), 0, 0);
  const GYR = { lat: 33.4225, lon: -112.3760 }, PHX = { lat: 33.4343, lon: -112.0116 };
  eq('nav dist GYR-PHX', Nav.dist(GYR, PHX), 18.27, 0.1); eq('nav brg GYR-PHX', Nav.brg(GYR, PHX), 87.68, 0.3);
  const vGyr = Nav.variation(GYR, new Date('2026-11-24'));
  tst('nav variation GYR 9.5..11 E', vGyr > 9.5 && vGyr < 11, vGyr);
  const vDen = Nav.variation({ lat: 39.74, lon: -104.99 }, new Date('2026-11-24')), vMia = Nav.variation({ lat: 25.76, lon: -80.19 }, new Date('2026-11-24'));
  tst('nav variation Denver ~ +7.5 E', Math.abs(vDen - 7.5) < 0.6, vDen); tst('nav variation Miami ~ -7.4 (W)', Math.abs(vMia + 7.4) < 0.6, vMia);
  const mcGE = Nav.magCourse(GYR, PHX, new Date('2026-11-24'));
  eq('nav magCourse = TC - E var', mcGE, 87.68 - vGyr, 1.5);
  const mid = Nav.mid(GYR, PHX); eq('nav mid lon', mid.lon, -112.194, 0.01);
  const off = Nav.offset(GYR, 87.68, 18.27); eq('nav offset east ~ PHX lon', off.lon, -112.0116, 0.02);
  eq('nav xtrack on line', Nav.xtrack(mid, GYR, PHX), 0, 0.05); eq('nav xtrack past end', Nav.xtrack({ lat: 33.4343, lon: -111.9 }, GYR, PHX), Nav.dist({ lat: 33.4343, lon: -111.9 }, PHX), 0.01);
  tst('nav fmtEet', Nav.fmtEet(5) === ':05' && Nav.fmtEet(65) === '1:05' && Nav.fmtEet(39) === ':39');
  tst('nav addHHMM', Nav.addHHMM('1006', 5) === '1011' && Nav.addHHMM('2358', 5) === '0003');

  // B02 worked example (SEP-26 p85): KGYR -> E63, T/O 1006, 54.5 USG, FF 12.7. Per-row winds/FF chosen so the
  // wind triangle reproduces the printed GS and WCA (B02's E6B figures differ slightly from pure maths at 250/10).
  const ofp = Nav.computeOfp({ toTime: '1006', takeoffFuel: 54.5, reserveMin: 30, cruiseFf: 12.7, rows: [
    { name: 'PIR', alt: 2700, msa: 6000, mc: null, dist: 5, tas: 146, ff: 12.9, fixed: { min: 5, nm: 5 } },
    { name: 'Gila Crossing', alt: 2700, msa: 6000, mc: 121, dist: 10, wdir: 250, wspd: 8, tas: 146, ff: 12.9, prevAlt: 2700 },
    { name: 'North Test Track', alt: 5500, msa: 5500, mc: 124, dist: 18, wdir: 240, wspd: 8, tas: 150, ff: 12.8, prevAlt: 2700 },
    { name: 'Motown', alt: 6500, msa: 4000, mc: 235, dist: 19, wdir: 240, wspd: 10, tas: 151, ff: 12.7, prevAlt: 5500, pattern: { airwork: 30 } },
    { name: 'Tire Farm', alt: 6500, msa: 4500, mc: 309, dist: 8, wdir: 240, wspd: 10, tas: 151, ff: 12.9, prevAlt: 6500 },
    { name: 'E63', alt: 1600, msa: 4500, mc: 245, dist: 16, wdir: 250, wspd: 10, tas: 151, ff: 12.7, prevAlt: 6500, pattern: { touchGo: 3, fullStop: true } }
  ] });
  const want = [ // eet, gs, wca, legFuel, plFuel, minFuel
    [5, null, null, 1.1, 53.4, 25.6], [4, 151, 2, 0.9, 52.5, 24.7], [9, 153, 3, 2.3, 50.2, 22.4],
    [39, 141, 0, 8.3, 41.9, 14.1], [4, 147, -4, 0.9, 41.0, 13.2], [32, 141, 0, 6.8, 34.2, 6.4]];
  ofp.rows.forEach((r, i) => {
    const w = want[i], n = 'B02 row ' + (i + 1) + ' ' + r.name + ' ';
    eq(n + 'EET', r.eet, w[0], 0); if (w[1] !== null) { eq(n + 'GS', r.gs, w[1], 0); eq(n + 'WCA', r.wca, w[2], 0); }
    eq(n + 'leg fuel', r.legFuel, w[3], 1e-9); eq(n + 'Pl fuel', r.plFuel, w[4], 1e-9); eq(n + 'Min fuel', r.minFuel, w[5], 1e-9);
  });
  eq('B02 trip fuel', ofp.totals.trip, 20.3, 1e-9); eq('B02 total EET', ofp.totals.eet, 93, 0); eq('B02 reserve', ofp.reserveGal, 6.4, 1e-9);
  eq('B02 PTO last', Number(ofp.rows[5].pto), 1139, 0);
  tst('B02 how string', /^8 NM \/ 147 kt = 3\.3 min/.test(ofp.rows[4].how.eet), ofp.rows[4].how.eet);
  // header wind 250/10 for every leg stays within 3 kt / 1 deg of B02's hand-E6B figures
  [[121, 146, 151, 2], [124, 150, 153, 3], [235, 151, 141, 0], [309, 151, 147, -4], [245, 151, 141, 0]].forEach(([mc, tas, gs, wca]) => {
    const t = Nav.windTriangle({ mc, tas, wdir: 250, wspd: 10 });
    tst('B02 header wind 250/10 close on MC ' + mc, Math.abs(t.gs - gs) <= 5 && Math.abs(t.wca - wca) <= 1, JSON.stringify(t));
  });
  // wind too strong: error row, no NaN anywhere
  const bad = Nav.computeOfp({ toTime: '1006', takeoffFuel: 50, reserveMin: 30, cruiseFf: 12.7, rows: [
    { name: 'A', alt: 5500, mc: 90, dist: 10, wdir: 0, wspd: 120, tas: 100, ff: 12.7 }, { name: 'B', alt: 5500, mc: 90, dist: 10, wdir: 90, wspd: 0, tas: 100, ff: 12.7 }] });
  tst('computeOfp wind error flagged, no NaN', bad.rows[0].error === 'wind' && !/NaN/.test(JSON.stringify(bad)) && bad.totals.incomplete === true, JSON.stringify(bad.totals));
  tst('computeOfp empty rows', Nav.computeOfp({ toTime: '1006', takeoffFuel: 50, reserveMin: 30, cruiseFf: 12.7, rows: [] }).rows.length === 0);
  // wrap through north in a full row
  const wr = Nav.computeOfp({ toTime: '1006', takeoffFuel: 50, reserveMin: 30, cruiseFf: 12.7, rows: [{ name: 'A', alt: 5500, mc: 358, dist: 13, wdir: 2, wspd: 20, tas: 150, ff: 12.7 }] });
  eq('computeOfp wrap GS', wr.rows[0].gs, 130, 0);
  const xm = Nav.computeOfp({ toTime: '1000', takeoffFuel: 40, reserveMin: 30, cruiseFf: 12.0, rows: [{ name: 'A', alt: 3500, mc: 90, dist: 12, wdir: 90, wspd: 0, tas: 150, ff: 12.0, prevAlt: 3500 }, { name: 'KGEU', alt: 2000, mc: 90, dist: 12, wdir: 90, wspd: 0, tas: 150, ff: 12.0, prevAlt: 3500, extraMin: 10, extraHow: 'Power Plant DEP into KGEU' }] });
  eq('computeOfp extraMin adds minutes', xm.rows[1].eet - xm.rows[0].eet, 10, 0);
  eq('computeOfp extraMin fuel at cruise FF', Math.round((xm.rows[1].legFuel - xm.rows[0].legFuel) * 10) / 10, 2.0, 1e-9);
  tst('computeOfp extraMin how and no pattern', /Power Plant DEP into KGEU/.test(xm.rows[1].how.extra) && !xm.rows[1].pattern);
}
// ==== end nav ====
// ==== cruise tests (OFP) ====
{
  const c = P.cruise({ pa: 6500, isaDev: 0 });
  eq('cruise 6500 ISA tas', c.tas, 151, 2); eq('cruise 6500 ISA ff', c.ff, 12.7, 0.3); eq('cruise 6500 ISA pwr', c.pwr, 74.5, 0.6);
  const g = P.cruise({ pa: 8000, isaDev: 0, pwr: 72 });
  eq('cruise 8000 grid pwr', g.pwr, 72); eq('cruise 8000 grid tas', g.tas, 152); eq('cruise 8000 grid ff', g.ff, 11.9);
  eq('cruise 8000 75% capped', P.cruise({ pa: 8000, isaDev: 0 }).capped, true);
  eq('cruise 4000 75% not capped', !!P.cruise({ pa: 4000, isaDev: 0 }).capped, false);
  eq('cruise pa clamps low', P.cruise({ pa: 0, isaDev: 0 }).tas, P.cruise({ pa: 2000, isaDev: 0 }).tas);
  eq('cruise pa clamps high', P.cruise({ pa: 20000, isaDev: 0 }).tas, P.cruise({ pa: 14000, isaDev: 0 }).tas);
  eq('cruise warmer is faster', P.cruise({ pa: 4000, isaDev: 15 }).tas > P.cruise({ pa: 4000, isaDev: 0 }).tas, true);
  eq('isaTemp 6000', P.isaTemp(6000), 3);
}
// ==== end cruise ====
// ==== ato tests (OFP) ====
{
  const ATO = require('./ato.js');
  const ok = (name, c) => { if (!c) fail++; console.log((c ? 'ok   ' : 'FAIL ') + name); };
  const dep = ATO.forAirport('KGYR', 'dep'), arr = ATO.forAirport('KGYR', 'arr');
  const by = (l, id) => l.find((p) => p.id === id);
  const bk = by(dep, 'GYR-DEP-BUCKEYE');
  ok('Buckeye DEP -> LIBERTY BRIDGE 4 min / 7 NM', bk && bk.point === 'LIBERTY BRIDGE' && bk.min === 4 && bk.nm === 7);
  const gc = by(dep, 'GYR-DEP-GILACROSSING');
  ok('Gila Crossing DEP -> PIR 5/5', gc && gc.point === 'PIR' && gc.min === 5 && gc.nm === 5);
  const tl = by(dep, 'GYR-DEP-TWINLAKES');
  ok('Twin Lakes DEP -> LIBERTY BRIDGE 5/7', tl && tl.point === 'LIBERTY BRIDGE' && tl.min === 5 && tl.nm === 7);
  const ppd = dep.find((p) => p.point === 'THE STACK'), ppa = arr.find((p) => p.point === 'THE STACK');
  ok('Stack arrival 3 min, Stack departure 5 min', ppa.min === 3 && ppd.min === 5 && ppa.nm === 6 && ppd.nm === 6);
  ok('Power Plant is dual only; +10 for KGEU', ppd.dualOnly && ppa.dualOnly && ppd.extraMinDest.KGEU === 10);
  ok('Luke Aux 6 / Gap / Gila Crossing arrivals', by(arr, 'GYR-ARR-LUKEAUX6').min === 3 && by(arr, 'GYR-ARR-LUKEAUX6').nm === 7
    && by(arr, 'GYR-ARR-GAP').min === 2 && by(arr, 'GYR-ARR-GAP').nm === 5
    && by(arr, 'GYR-ARR-GILACROSSING').min === 6 && by(arr, 'GYR-ARR-GILACROSSING').nm === 14);
  ok('KGYR full-stop arrivals add 10 min, departures 0', arr.every((p) => p.extraMin === 10) && dep.every((p) => p.extraMin === 0));
  ok('ids unique', new Set(ATO.procedures.map((p) => p.id)).size === ATO.procedures.length);
  const names = new Set(ATO.points.map((p) => p.name));
  ok('point names unique and every procedure point is listed', names.size === ATO.points.length && ATO.procedures.every((p) => names.has(p.point)));
  ok('forAirport filters kind', dep.every((p) => p.kind === 'dep') && ATO.forAirport('KGYR').length === dep.length + arr.length);
  ok('forAirport unknown airport is empty', ATO.forAirport('KXXX', 'dep').length === 0);
  ok('usable false with no waypoints', !ATO.usable(bk, {}) && !ATO.usable(bk, null) && !ATO.usable(bk, { 'LIBERTY BRIDGE': {} }) && !ATO.usable(bk, { 'LIBERTY BRIDGE': { lat: null, lon: null } }));
  ok('usable true with coordinates', ATO.usable(bk, { 'LIBERTY BRIDGE': { lat: 33.3, lon: -112.6 } }));
}
// ==== end ato ====
// ==== ato2 tests (OFP) ====
{
  const ATO = require('./ato.js');
  const ok = (name, c) => { if (!c) fail++; console.log((c ? 'ok   ' : 'FAIL ') + name); };
  const byId = (id) => ATO.procedures.find((p) => p.id === id);
  const bk = byId('GYR-DEP-BUCKEYE'), gap = byId('GYR-ARR-GAP');
  const wx = ATO.expand(bk, 'GYR-DEP-BUCKEYE.WEST');
  ok('Buckeye DEP Western: LIBERTY BRIDGE gate first, then Arlington, ends at Hassayampa/I-10',
    wx[0].name === 'LIBERTY BRIDGE' && wx[0].role === 'gate' && wx[1].name === 'ARLINGTON' && wx[1].alt === 3000 && wx[1].role === 'trans'
    && wx[wx.length - 1].name === 'HASSAYAMPA I-10' && wx[wx.length - 1].alt === 5000);
  const tf = ATO.expand(gap, 'GYR-ARR-GAP.TIREFARM');
  ok('Gap ARR Tire Farm: TIRE FARM first, THE GAP last (gate)',
    tf[0].name === 'TIRE FARM' && tf[0].alt === 3500 && tf[tf.length - 1].name === 'THE GAP' && tf[tf.length - 1].role === 'gate' && tf.filter((p) => p.role === 'gate').length === 1);
  ok('unknown / empty transition -> only the gate', ['NOPE', '', null, undefined].every((t) => { const e = ATO.expand(bk, t); return e.length === 1 && e[0].name === 'LIBERTY BRIDGE' && e[0].role === 'gate'; }));
  ok('transition ids are <procId>.<SHORT> and unique', ATO.procedures.every((p) => p.transitions.every((t) => t.id.indexOf(p.id + '.') === 0))
    && new Set([].concat(...ATO.procedures.map((p) => p.transitions.map((t) => t.id)))).size === [].concat(...ATO.procedures.map((p) => p.transitions)).length);
  ok('gate and legacy point agree', ATO.procedures.every((p) => p.gate && p.point === p.gate && Array.isArray(p.transitions)));
  ok('flags per plate: Gap South dual, Twin Lakes Southwest dual, (SOLO) routes stay open to dual flights',
    gap.transitions.find((t) => t.id === 'GYR-ARR-GAP.SOUTH').dualOnly && byId('GYR-DEP-TWINLAKES').transitions.find((t) => t.name === 'Southwest').dualOnly
    && !byId('GYR-ARR-LUKEAUX6').transitions.find((t) => t.name === 'Northwest').soloOnly && !bk.transitions.find((t) => t.name === 'Tonopah').soloOnly);
  ok('Glendale ARR entry at 2100', byId('GEU-ARR-GLENDALE').alt === 2100);
  // merge
  const defs = ATO.procedures.slice(0, 3), snap = JSON.stringify(defs);
  const rows = [
    { id: 'GYR-DEP-BUCKEYE', data: Object.assign({}, bk, { alt: '2500' }) },
    { id: 'ZZ-NEW-2', data: { airport: 'KAAA', kind: 'dep', name: 'B proc', gate: 'X2', transitions: [{ name: 'Left', points: [{ name: 'P1', alt: '3000' }] }] } },
    { id: 'ZZ-NEW-1', data: { airport: 'KAAA', kind: 'dep', name: 'A proc', gate: 'X1' } },
    { id: 'GYR-DEP-TWINLAKES', hidden: true },
    null, 'junk', { id: 5, data: {} }, { id: 'BAD', data: 'x' }, { data: { gate: 'Q' } }, { id: 'BAD2' },
  ];
  const rowsSnap = JSON.stringify(rows);
  const m = ATO.merge(defs, rows);
  ok('merge: override replaces (alt coerced to number)', m.find((p) => p.id === 'GYR-DEP-BUCKEYE').alt === 2500);
  ok('merge: hidden removes', !m.some((p) => p.id === 'GYR-DEP-TWINLAKES'));
  ok('merge: order = defaults, then new sorted by airport/kind/name', m.map((p) => p.id).join() === 'GYR-DEP-GILACROSSING,GYR-DEP-BUCKEYE,ZZ-NEW-1,ZZ-NEW-2');
  const nw = m.find((p) => p.id === 'ZZ-NEW-2');
  ok('merge: new rows normalized (transition id generated, point alt numeric, flags false)', nw.point === 'X2' && nw.transitions[0].id === 'ZZ-NEW-2.LEFT'
    && nw.transitions[0].points[0].alt === 3000 && nw.dualOnly === false && nw.transitions[0].soloOnly === false && nw.extraMin === 0 && nw.min === null);
  ok('merge: malformed rows ignored', m.length === 4 && !m.some((p) => p.id === 'BAD' || p.id === 'BAD2'));
  ok('merge: inputs not mutated', JSON.stringify(defs) === snap && JSON.stringify(rows) === rowsSnap && ATO.procedures[1].alt === 2000);
  ok('merge: null / undefined rows keep defaults', ATO.merge(ATO.procedures, null).length === ATO.procedures.length && ATO.merge(ATO.procedures).length === ATO.procedures.length);
  ok('normalize: empty input is safe', (() => { const n = ATO.normalize(null); return n.transitions.length === 0 && n.extraMin === 0 && n.dualOnly === false && n.soloOnly === false && n.point === n.gate; })());
  ok('forAirport with a custom list', ATO.forAirport('KAAA', 'dep', m).length === 2 && ATO.forAirport('KAAA', 'dep').length === 0);
  // usable
  const W = { 'LIBERTY BRIDGE': { lat: 33.36, lon: -112.6 }, ARLINGTON: { lat: 33.34, lon: -112.76 } };
  ok('usable: false when a transition point is missing', !ATO.usable(bk, 'GYR-DEP-BUCKEYE.WEST', W));
  ok('usable: true when all placed (uppercase lookup)', ATO.usable(bk, 'GYR-DEP-BUCKEYE.WEST', Object.assign({ 'hassayampa i-10': null, 'HASSAYAMPA I-10': { lat: 33.45, lon: -112.8 } }, W)));
  ok('usable: legacy 2-arg form checks the gate only', ATO.usable(bk, W) && !ATO.usable(bk, {}) && ATO.usable(bk, null, W));
  // B02 numbers
  const b02 = { 'GYR-DEP-GILACROSSING': ['PIR', 5, 5], 'GYR-DEP-BUCKEYE': ['LIBERTY BRIDGE', 4, 7], 'GYR-DEP-TWINLAKES': ['LIBERTY BRIDGE', 5, 7], 'GYR-DEP-POWERPLANT': ['THE STACK', 5, 6],
    'GYR-ARR-LUKEAUX6': ['LUKE AUX 6', 3, 7], 'GYR-ARR-GAP': ['THE GAP', 2, 5], 'GYR-ARR-GILACROSSING': ['GILA CROSSING', 6, 14], 'GYR-ARR-POWERPLANT': ['THE STACK', 3, 6] };
  ok('B02 gate/min/nm unchanged for the 8 KGYR procedures', Object.keys(b02).every((id) => { const p = byId(id), w = b02[id]; return p && p.gate === w[0] && p.min === w[1] && p.nm === w[2]; })
    && ATO.forAirport('KGYR').length === 8);
  ok('full-stop +10 on all four KGYR arrivals', ATO.forAirport('KGYR', 'arr').length === 4 && ATO.forAirport('KGYR', 'arr').every((p) => p.extraMin === 10));
  ok('Power Plant DEP +10 into KGEU, PP dep/arr dual only', byId('GYR-DEP-POWERPLANT').extraMinDest.KGEU === 10 && byId('GYR-DEP-POWERPLANT').dualOnly && byId('GYR-ARR-POWERPLANT').dualOnly);
  // point names
  const listed = new Set(ATO.points.map((p) => p.name)), all = ATO.pointNames(ATO.procedures);
  ok('every gate/transition point is uppercase, <=40 chars and listed in ATO.points',
    all.length > 20 && all.every((n) => n === n.toUpperCase() && n.length <= 40 && listed.has(n)) && ATO.points.every((p) => p.desc && all.indexOf(p.name) >= 0));
  ok('pointNames sorted unique', all.join('|') === Array.from(new Set(all)).sort().join('|'));
}
// ==== end ato2 ====
// ==== print tests (OFP) ====
{
  const OP = require('./ofpprint.js');
  const mkRow = (i, o) => Object.assign({ name: 'PT' + i, ident: 'PT' + i, lat: 33.4, lon: -112.5, alt: 5500, msa: 6000, mc: 90 + i, dist: 12.3, wdir: 250, wspd: 10, tas: 100, ff: 12.7,
    wca: -4, gs: 105, eet: 7, pto: '1013', legFuel: 1.5, plFuel: 50.0, minFuel: 20.1, fixed: null, pattern: null }, o || {});
  const mkLog = (n) => ({ rows: Array.from({ length: n }, (_, i) => mkRow(i)), totals: { eet: 49, trip: 10.5 } });
  const hdr = { from: 'KGYR', to: 'KE63', offBlock: '1000', onBlock: '1130', toTime: '1006', callsign: 'N123AB', reg: 'N123AB', cruiseFf: 12.7, magWind: '250/10', alt: '5500', date: '26 Apr 2025',
    mission: 'NAV', crew: ['Smith', 'Jones'], takeoffFuel: 54.5, notes: ['Verify MSA on chart', 'Wx: CAVOK'] };
  const inBox = (it, b) => it.x >= b.x0 - 0.01 && it.x + it.text.length * it.size * 0.5 <= b.x1 + 0.01 && it.y >= b.y0 && it.y + it.size * 0.7 <= b.y1 + 0.5;
  const L1 = OP.layout(mkLog(7), hdr);
  const e1 = L1.find((it) => it.text === ':07');
  const b1 = OP.cell('left', 0, 'eet', 0);
  console.log((e1 && inBox(e1, b1) ? 'ok   ' : 'FAIL ') + 'leg1 EET inside left EET cell'); if (!(e1 && inBox(e1, b1))) fail++;
  // 19 legs -> 18 placed; leg 12 is the first on the right ladder
  const L18 = OP.layout(mkLog(19), hdr);
  const wpts = L18.filter((it) => /^PT\d+$/.test(it.text)).map((it) => it.text);
  eq('19-leg log places 18 legs', wpts.length, 18, 0);
  eq('leg 11 still left', L18.find((it) => it.text === 'PT10').x < 396 ? 1 : 0, 1, 0);
  eq('leg 12 is on the right ladder', L18.find((it) => it.text === 'PT11').x > 396 ? 1 : 0, 1, 0);
  eq('no ETO ever printed', L18.filter((it) => it.text === '1013' && it.x > 192.9 && it.x < 227.8 && it.y > 400).length, 0, 0);
  // fixed first leg: Dep in MC, no WCA/GS, only MC XXX covered; non-fixed: all four covered, MC printed
  const fx = { rows: [mkRow(0, { name: 'PIR', fixed: { min: 5, nm: 5 }, eet: 5, dist: 5 })], totals: { eet: 5, trip: 1 } };
  const Lf = OP.layout(fx, hdr);
  eq('fixed leg prints Dep', Lf.filter((it) => it.text === 'Dep').length, 1, 0);
  eq('fixed leg: no GS/WCA text', Lf.filter((it) => it.text === '105' || it.text === '-4').length, 0, 0);
  eq('fixed leg covers', OP.covers(fx).join() === '0,4,5' ? 1 : 0, 1, 0);
  eq('non-fixed leg covers all XXX', OP.covers(mkLog(2)).join() === '0,1,2,3,4,5' ? 1 : 0, 1, 0);
  eq('non-fixed leg prints GS and WCA', OP.layout(mkLog(2), hdr).filter((it) => it.text === '105' || it.text === '-4').length >= 2 ? 1 : 0, 1, 0);
  // long name truncated to the cell
  const LL = OP.layout({ rows: [mkRow(0, { name: 'A'.repeat(30), ident: 'A'.repeat(30) })], totals: { eet: 7, trip: 1.5 } }, hdr);
  const ln = LL.find((it) => /^A+$/.test(it.text));
  eq('long WPT name fits cell', ln.text.length * ln.size * 0.5 <= OP.cell('left', 0, 'wpt', 0).x1 - OP.cell('left', 0, 'wpt', 0).x0 ? 1 : 0, 1, 0);
  console.log((ln.text.length < 30 ? 'ok   ' : 'FAIL ') + 'long WPT name truncated'); if (ln.text.length >= 30) fail++;
  // wind error leg and non-finite values: never NaN/undefined
  const bad = { rows: [mkRow(0, { error: 'wind', gs: NaN, wca: undefined, eet: NaN, legFuel: NaN, plFuel: NaN, minFuel: NaN, pto: undefined, dist: Infinity }), mkRow(1, { mc: NaN, alt: undefined, msa: null })], totals: { eet: NaN, trip: NaN } };
  const hb = Object.assign({}, hdr, { cruiseFf: NaN, takeoffFuel: undefined, magWind: 'NaN/undefined' });
  const bad_it = OP.layout(bad, hb).filter((it) => /NaN|undefined|Infinity/.test(it.text));
  eq('no NaN/undefined text items', bad_it.length, 0, 0);
  const nan_it = L18.filter((it) => /NaN|undefined/.test(it.text));
  eq('no NaN/undefined in normal log', nan_it.length, 0, 0);
  eq('remarks T&G', OP.layout({ rows: [mkRow(0, { pattern: { touchGo: 3, taxiBack: 0, fullStop: true, airwork: 20 } })], totals: {} }, hdr).filter((it) => /T&G \(3\)|AIRWORK|Full stop/.test(it.text)).length >= 2 ? 1 : 0, 1, 0);
  // fpl
  const xml = OP.fpl([
    { name: 'KGYR', ident: 'KGYR', lat: 33.4225, lon: -112.376, type: 'AIRPORT' },
    { name: 'Sun Valley Rd', ident: '', lat: 33.35, lon: -112.5333, type: 'USER WAYPOINT' },
    { name: 'KE63', ident: 'KE63', lat: 33.3, lon: -112.0, type: 'AIRPORT' },
  ]);
  eq('fpl waypoint count', (xml.match(/<waypoint>/g) || []).length, 3, 0);
  eq('fpl route-point count', (xml.match(/<route-point>/g) || []).length, 3, 0);
  console.log((xml.includes('xmlns="http://www8.garmin.com/xmlschemas/FlightPlan/v1"') ? 'ok   ' : 'FAIL ') + 'fpl namespace'); if (!xml.includes('FlightPlan/v1')) fail++;
  const uid = (xml.match(/<identifier>([^<]*)<\/identifier>/g) || [])[1].replace(/<[^>]+>/g, '');
  eq('fpl user id <= 6 chars', uid.length <= 6 && /^[A-Z0-9]+$/.test(uid) ? 1 : 0, 1, 0);
  // two user points with colliding ids stay unique
  const x2 = OP.fpl([{ name: 'Sun Valley A', lat: 33.1, lon: -112.1, type: 'USER WAYPOINT' }, { name: 'Sun Valley B', lat: 33.2, lon: -112.2, type: 'USER WAYPOINT' }]);
  const ids2 = (x2.match(/<identifier>([^<]*)<\/identifier>/g) || []);
  eq('colliding user ids unique', new Set(ids2).size, 2, 0);
  console.log((OP.routeString([{ ident: 'KGYR', type: 'AIRPORT', lat: 33.4, lon: -112.7 }, { lat: 33.35, lon: -112.5333, type: 'USER WAYPOINT' }, { ident: 'KE63', type: 'AIRPORT', lat: 33.3, lon: -112 }]) === 'KGYR 3321N/11232W KE63' ? 'ok   ' : 'FAIL ') + 'routeString'); 
  if (OP.routeString([{ lat: 33.35, lon: -112.5333, type: 'USER WAYPOINT' }]) !== '3321N/11232W') fail++;
}
// PDF build is async and test.js exits synchronously, so run it in a child process
{
  const out = require('child_process').execFileSync(process.execPath, ['-e', "require('./ofpprint.js').buildPdf({ rows: [{ name: 'KGYR', alt: 2700, msa: 3000, mc: 90, dist: 10, wca: 0, gs: 100, eet: 6, pto: '1012', legFuel: 1.2, plFuel: 53.3, minFuel: 10, pattern: { touchGo: 3 } }], totals: { eet: 6, trip: 1.2 } }, { from: 'KGYR', to: 'KGYR' }).then((b) => console.log(b.length + ' ' + Buffer.from(b.slice(0, 4)).toString()))"], { cwd: __dirname }).toString().trim().split(' ');
  const ok = +out[0] > 10000 && out[1] === '%PDF';
  console.log((ok ? 'ok   ' : 'FAIL ') + 'OFP buildPdf bytes ' + out.join(' ')); if (!ok) fail++;
}
// ==== end print ====
// ==== ffurl tests (OFP) ====
{
  const OPF = require('./ofpprint.js');
  const streq = (name, got, want) => { const ok = got === want; if (!ok) fail++; console.log((ok ? 'ok   ' : 'FAIL ') + name + ' got ' + got + ' want ' + want); };
  const etd = new Date(Date.UTC(2026, 10, 24, 17, 5, 0));
  const kgyr = { type: 'AIRPORT', ident: 'KGYR', lat: 33.4, lon: -112.4 };
  const pt = { type: 'USER WAYPOINT', ident: null, lat: 33.4225, lon: -112.3760 };
  const e63 = { type: 'AIRPORT', ident: 'E63', lat: 33.3, lon: -112.2 };
  const full = { tas: 152, ff: 12.8, alt: 6500, aircraft: 'var-848', etd };
  const P = 'foreflightmobile://maps/search?q=';
  streq('ff url full', OPF.foreflightUrl([kgyr, pt, e63], full), P + 'KGYR+332521N%2F1122234W+E63+152kts+12.8gph+6500ft+VAR848+20261124T17%3A05%3A00Z');
  streq('ff url ff 13.0 drops .0', OPF.foreflightUrl([kgyr], { tas: 100, ff: 13.0 }), P + 'KGYR+100kts+13gph');
  streq('ff url only waypoints when opts missing', OPF.foreflightUrl([kgyr, e63], {}), P + 'KGYR+E63');
  streq('ff url no opts', OPF.foreflightUrl([kgyr, e63]), P + 'KGYR+E63');
  streq('ff url seconds carry to degrees', OPF.foreflightUrl([{ type: 'USER WAYPOINT', lat: 33.999999, lon: 10 }], {}), P + '340000N%2F0100000E');
  streq('ff url southern/eastern hemisphere', OPF.foreflightUrl([{ type: 'USER WAYPOINT', lat: -33.5, lon: 151.25 }], {}), P + '333000S%2F1511500E');
  streq('ff url collapses consecutive duplicates', OPF.foreflightUrl([kgyr, kgyr, e63, e63, kgyr], {}), P + 'KGYR+E63+KGYR');
}
// ==== end ffurl ====
// ==== safety tests (OFP) ====
{
  const Nav = require('./nav.js'), S = require('./safety.js');
  const tst = (name, ok, extra) => { if (!ok) fail++; console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok ? '' : ' ' + (extra || ''))); };
  // interpWind on model levels (alt ft MSL; temp may be missing on a level)
  const PH = [{ alt: 3000, dir: 210, spd: 13, temp: null }, { alt: 6000, dir: 230, spd: 25, temp: 17 }, { alt: 9000, dir: 240, spd: 31, temp: 10 }];
  const w45 = S.interpWind(PH, 4500);
  eq('interpWind 4500 dir', w45.dir, 220, 3); eq('interpWind 4500 spd', w45.spd, 19, 1); eq('interpWind 4500 temp (lapse below 6000)', w45.temp, 20, 0.5);
  eq('interpWind exact level', S.interpWind(PH, 6000).spd, 25, 0);
  eq('interpWind below lowest holds 3000', S.interpWind(PH, 1500).spd, 13, 0);
  eq('interpWind 350/010 averages to north', Math.abs(Nav.angDiff(S.interpWind([{ alt: 3000, dir: 350, spd: 20 }, { alt: 6000, dir: 10, spd: 20 }], 4500).dir, 0)), 0, 1);
  tst('interpWind of nothing is null', S.interpWind({}, 5000) === null && S.interpWind(null, 5000) === null && S.interpWind([], 5000) === null);

  // altitude profile
  const pr = S.legProfile([{ dist: 30, alt: 5500, prevAlt: 2700 }, { dist: 30, alt: 1600, prevAlt: 6500, last: true }, { dist: 5, alt: 9500, prevAlt: 2700 }]);
  eq('climb leg: TOC at', pr[0][0].distTo, Nav.tocNm(2700, 5500), 0.01); eq('climb leg: level after TOC', pr[0][1].altFrom, 5500, 0);
  eq('last leg: descent starts at TOD', pr[1][1].distFrom, 30 - Nav.todNm(6500, 1600), 0.01); eq('last leg: descent ends at TPA', pr[1][1].altTo, 1600, 0);
  tst('short leg: climb does not finish, altitude interpolated', pr[2][0].distTo === 5 && pr[2][0].altTo < 9500 && pr[2][0].altTo > 2700);
  eq('altAt mid-climb', S.altAt(pr[0], Nav.tocNm(2700, 5500) / 2), 4100, 1);

  // airspace: a Class B shelf 3000-9000 ft over a square
  const A0 = { lat: 33.00, lon: -112.00 }, B0 = { lat: 33.00, lon: -111.50 };      // about 25 NM east
  const sq = [[32.9, -111.9], [32.9, -111.6], [33.1, -111.6], [33.1, -111.9]];
  const shelf = { name: 'TEST CLASS B', cls: 'B', lowerFt: 3000, upperFt: 9000, lowerRef: 'MSL', rings: [sq] };
  const lenAB = Nav.dist(A0, B0);
  const low = S.airspaceConflicts(A0, B0, S.legProfile([{ dist: lenAB, alt: 2500, prevAlt: 2500, last: false }])[0], [shelf]);
  tst('2500 ft under the shelf', low.length === 1 && low[0].kind === 'under-shelf' && low[0].cls === 'B', JSON.stringify(low));
  const mid = S.airspaceConflicts(A0, B0, S.legProfile([{ dist: lenAB, alt: 5500, prevAlt: 5500, last: false }])[0], [shelf]);
  tst('5500 ft inside the shelf', mid.length === 1 && mid[0].kind === 'inside' && mid[0].fromNm > 5 && mid[0].toNm < 20, JSON.stringify(mid));
  const high = S.airspaceConflicts(A0, B0, S.legProfile([{ dist: lenAB, alt: 9500, prevAlt: 9500, last: false }])[0], [shelf]);
  eq('9500 ft over the shelf: no conflict', high.length, 0, 0);
  const sfcD = { name: 'TEST D', cls: 'D', lowerFt: 0, upperFt: 3000, lowerRef: 'SFC', rings: [sq] };
  eq('class D at 2500 ft: inside', S.airspaceConflicts(A0, B0, S.legProfile([{ dist: lenAB, alt: 2500, prevAlt: 2500, last: false }])[0], [sfcD])[0].kind === 'inside' ? 1 : 0, 1, 0);
  const aglMoa = { name: 'TEST MOA', cls: 'MOA', lowerFt: 500, upperFt: 6500, lowerRef: 'SFC', rings: [sq] };
  eq('MOA with 500 AGL floor, flying 4000 with ground 3000', S.airspaceConflicts(A0, B0, S.legProfile([{ dist: lenAB, alt: 4000, prevAlt: 4000, last: false }])[0], [aglMoa], { groundFt: 3000 }).length, 1, 0);
  eq('MOA with 500 AGL floor, flying 2000 with ground 3000: below floor', S.airspaceConflicts(A0, B0, S.legProfile([{ dist: lenAB, alt: 2000, prevAlt: 2000, last: false }])[0], [aglMoa], { groundFt: 3000 }).length, 0, 0);
  eq('no airspace data gives no conflicts', S.airspaceConflicts(A0, B0, [], []).length + S.airspaceConflicts(A0, B0, [], null).length, 0, 0);
  // ADDS attribute semantics, from live features (Class_Airspace PHX Class B Area B; SUA A-231; class E5; class A)
  const fB = S.fromAddsAirspace({ attributes: { NAME: 'PHOENIX CLASS B', CLASS: 'B', LOCAL_TYPE: 'CLASS_B', UPPER_VAL: 9000, UPPER_UOM: 'FT', UPPER_CODE: 'MSL', LOWER_VAL: 3000, LOWER_UOM: 'FT', LOWER_CODE: 'MSL' }, geometry: { rings: [[[-112.1, 33.4], [-112.0, 33.4], [-112.0, 33.5]]] } }, 'class');
  tst('ADDS class B floor/ceiling', fB && fB.cls === 'B' && fB.lowerFt === 3000 && fB.upperFt === 9000 && fB.lowerRef === 'MSL' && fB.rings[0][0][0] === 33.4 && fB.rings[0][0][1] === -112.1);
  const fS = S.fromAddsAirspace({ attributes: { NAME: 'A-231', TYPE_CODE: 'A', UPPER_VAL: '6500', UPPER_UOM: 'FT', UPPER_CODE: 'MSL', LOWER_VAL: '500', LOWER_UOM: 'FT', LOWER_CODE: 'SFC' }, geometry: { rings: [[[-112.1, 33.4], [-112.0, 33.4], [-112.0, 33.5]]] } }, 'sua');
  tst('ADDS SUA alert area, string values, 500 AGL', fS && fS.cls === 'ALERT' && fS.lowerFt === 500 && fS.lowerRef === 'SFC' && fS.upperFt === 6500);
  eq('ADDS surface floor', S.fromAddsAirspace({ attributes: { NAME: 'PHOENIX MODE C', LOCAL_TYPE: 'MODE C', CLASS: null, UPPER_VAL: 10000, UPPER_UOM: 'FT', UPPER_CODE: 'MSL', LOWER_VAL: 0, LOWER_UOM: 'FT', LOWER_CODE: 'SFC' }, geometry: { rings: [[[-112, 33], [-111, 33], [-111, 34]]] } }, 'class').cls === 'MODEC' ? 1 : 0, 1, 0);
  eq('ADDS FL600 ceiling', S.addsAlt(600, 'FL', 'STD'), 60000, 0); eq('ADDS -9998 is unlimited', S.addsAlt(-9998, null, null), S.UNLIMITED, 0);
  tst('ADDS feature without geometry is skipped', S.fromAddsAirspace({ attributes: { NAME: 'X', CLASS: 'B' } }, 'class') === null);

  // glide reach
  const g0 = S.glide(A0, B0, 5500, []);
  tst('glide with no fields: one gap over the whole leg', g0.fields.length === 0 && g0.gaps.length === 1 && g0.gaps[0].fromNm === 0 && Math.abs(g0.gaps[0].toNm - lenAB) < 0.2, JSON.stringify(g0));
  const apt = { ident: 'KTST', lat: 33.0, lon: -111.75, elev: 1000 };    // mid-leg; reach at 5500 ft = 4500/6076*9*0.8 = 5.3 NM
  const g1 = S.glide(A0, B0, 5500, [apt]);
  tst('glide with one field: field listed and gaps either side', g1.fields.length === 1 && g1.fields[0].ident === 'KTST' && Math.abs(g1.fields[0].distNm - lenAB / 2) < 1.1 && g1.gaps.length === 2, JSON.stringify(g1));
  eq('glide high enough covers the leg', S.glide(A0, B0, 12500, [apt]).gaps.length, 0, 0);
  eq('glide with null fields', S.glide(A0, B0, 5500, null).gaps.length, 1, 0);

  // terrain / obstacles
  const t = S.tileOf(33.4343, -112.0116, 11);
  const back = S.tilePixelLatLon(11, t.x, t.y, t.px, t.py);
  eq('tile round-trip lat', back.lat, 33.4343, 1e-6); eq('tile round-trip lon', back.lon, -112.0116, 1e-6);
  eq('Terrarium 0 m', S.terrainFt(128, 0, 0), 0, 1e-6); eq('Terrarium 1000 m in ft', S.terrainFt(131, 232, 0), 1000 * 3.28084, 0.01);
  const ptsC = S.corridorPoints(A0, B0, 5, 0.5, 1);
  tst('corridor points all within 5 NM of the leg', ptsC.length > 100 && ptsC.every((p) => Nav.xtrack(p, A0, B0) <= 5 + 1e-6));
  const tile = new Uint8ClampedArray(256 * 256 * 4); for (let i = 0; i < 256 * 256; i++) { tile[i * 4] = 128; tile[i * 4 + 1] = 100; tile[i * 4 + 3] = 255; } // 100 m everywhere
  const pk = S.tileOf(33.0, -111.75, 11); const pi = (Math.min(255, Math.floor(pk.py)) * 256 + Math.min(255, Math.floor(pk.px))) * 4; tile[pi + 1] = 200; // 200 m peak
  const mt = S.maxTerrain([{ lat: 33.0, lon: -111.75 }], 11, () => tile);
  eq('maxTerrain finds the peak', mt.ft, 200 * 3.28084, 1); eq('maxTerrain lat near the peak', mt.lat, 33.0, 0.003);
  const mm = S.maxTerrain([{ lat: 33, lon: -111.75 }], 11, () => null);
  tst('maxTerrain with a missing tile is null ft, not 0', mm && mm.ft === null && mm.missing === 1);
  eq('maxTerrain with no points', S.maxTerrain([], 11, () => tile) === null ? 1 : 0, 1, 0);
  const me = S.maxElevation({ ft: 4512, lat: 33, lon: -111.8 }, [{ lat: 33.02, lon: -111.7, amsl: 5100 }, { lat: 34.5, lon: -111.7, amsl: 9000 }], A0, B0, 5);
  tst('maxElevation: obstacle near the leg wins, far one ignored', me.kind === 'obstacle' && me.ft === 5100 && me.msa === 6500, JSON.stringify(me));
  eq('maxElevation terrain only: 4512 -> MSA 6000', S.maxElevation({ ft: 4512, lat: 1, lon: 1 }, [], A0, B0).msa, 6000, 0);
  eq('maxElevation with no data is null', S.maxElevation(null, [], A0, B0) === null && S.maxElevation({ ft: null }, null, A0, B0) === null ? 1 : 0, 1, 0);

  // checks
  const LATA = require('./airports.js');
  const mkRow = (o) => Object.assign({ name: 'WP', ident: '', dist: 10, mc: 90, alt: 3500, msa: 3000, plFuel: 40, minFuel: 10, fixed: null }, o);
  const codes = (cs) => cs.map((c) => c.code + (c.leg === null ? '' : '@' + c.leg));
  let cs = S.checks({ log: { rows: [mkRow({ dist: 35 })] } });
  tst('35 NM leg gives leg30', codes(cs).includes('leg30@0'), codes(cs).join());
  cs = S.checks({ log: { rows: [mkRow({ mc: 270, alt: 5500 })] } });
  tst('5500 ft westbound gives semicircular', codes(cs).includes('semicircular@0'), codes(cs).join());
  tst('5500 ft eastbound is fine', !codes(S.checks({ log: { rows: [mkRow({ mc: 90, alt: 5500 })] } })).includes('semicircular@0'));
  tst('wrap: MC 358 is westbound (even): 5500 warns, 6500 fine', codes(S.checks({ log: { rows: [mkRow({ mc: 358, alt: 5500 })] } })).includes('semicircular@0') && !codes(S.checks({ log: { rows: [mkRow({ mc: 358, alt: 6500 })] } })).includes('semicircular@0'));
  tst('wrap: MC 002 is eastbound (odd): 5500 fine, 6500 warns', !codes(S.checks({ log: { rows: [mkRow({ mc: 2, alt: 5500 })] } })).includes('semicircular@0') && codes(S.checks({ log: { rows: [mkRow({ mc: 2, alt: 6500 })] } })).includes('semicircular@0'));
  tst('low altitude is exempt (3500 AGL rule)', !codes(S.checks({ log: { rows: [mkRow({ mc: 270, alt: 3500 })] }, rows: [mkRow({ groundFt: 1000 })] })).includes('semicircular@0'));
  tst('below MSA', codes(S.checks({ log: { rows: [mkRow({ alt: 3500, msa: 6000 })] } })).includes('belowMsa@0'));
  cs = S.checks({ log: { rows: [mkRow({})] }, sources: { terrain: { ok: false }, airspace: { ok: true } } });
  tst('terrain unavailable gives dataMissing and only that source', codes(cs).filter((c) => c === 'dataMissing').length === 1 && /Terrain/.test(cs.find((c) => c.code === 'dataMissing').text), codes(cs).join());
  tst('wind error row gives windErr', codes(S.checks({ log: { rows: [mkRow({ error: 'wind', gs: null, eet: null })] } })).includes('windErr@0'));
  tst('18+ legs gives legs18, 18 does not', codes(S.checks({ log: { rows: Array.from({ length: 19 }, () => mkRow({})) } })).includes('legs18') && !codes(S.checks({ log: { rows: Array.from({ length: 18 }, () => mkRow({})) } })).includes('legs18'));
  tst('fuel over 56 and under reserve', (() => { const c = codes(S.checks({ log: { rows: [mkRow({ plFuel: 5, minFuel: 10 })] }, takeoffFuel: 57 })); return c.includes('fuelUsable') && c.includes('fuelReserve@0'); })());
  tst('airspace conflict becomes warn, shelf becomes info', (() => {
    const c = S.checks({ log: { rows: [mkRow({})] }, conflicts: [[{ name: 'PHOENIX CLASS B', cls: 'B', lowerFt: 3000, upperFt: 9000, lowerRef: 'MSL', fromNm: 2, toNm: 6, kind: 'inside' }, { name: 'PHOENIX CLASS B', cls: 'B', lowerFt: 7000, upperFt: 9000, lowerRef: 'MSL', fromNm: 6, toNm: 8, kind: 'under-shelf' }]] });
    return c.filter((x) => x.code === 'airspace').map((x) => x.level).join() === 'warn,info';
  })());
  tst('glide gap becomes glideGap', codes(S.checks({ log: { rows: [mkRow({})] }, glide: [{ fields: [], gaps: [{ fromNm: 1, toNm: 4 }] }] })).includes('glideGap@0'));
  // noise reduction: Mode C once, surface areas as info, one line per leg and class, small glide gaps as info
  const inB = (a, b, f, t2, lo) => ({ name: 'PHOENIX CLASS B', cls: 'B', lowerFt: lo, upperFt: 9000, lowerRef: lo === 0 ? 'SFC' : 'MSL', fromNm: f, toNm: t2, kind: 'inside' });
  const modec = { name: 'PHOENIX SKY HARBOR INTERNATIONAL MODE C', cls: 'MODEC', lowerFt: 0, upperFt: 10000, lowerRef: 'SFC', fromNm: 0, toNm: 9, kind: 'inside' };
  cs = S.checks({ log: { rows: [mkRow({}), mkRow({})] }, conflicts: [[modec], [modec]] });
  tst('Mode C veil: one info line, no warnings', cs.filter((c) => c.code === 'modeC').length === 1 && cs.filter((c) => c.level === 'warn').length === 0 && cs.filter((c) => c.code === 'airspace').length === 0, codes(cs).join());
  const gyrD = { name: 'PHOENIX-GOODYEAR MUNICIPAL AIRPORT CLASS D', cls: 'D', lowerFt: 0, upperFt: 3000, lowerRef: 'SFC', fromNm: 0, toNm: 3, kind: 'inside', ap: 'KGYR' };
  cs = S.checks({ log: { rows: [mkRow({}), mkRow({})] }, airports: LATA, dep: 'KGYR', dest: 'KGEU', conflicts: [[gyrD], []] });
  tst('departure surface area is one info', cs.filter((c) => c.code === 'terminal').length === 1 && cs.find((c) => c.code === 'terminal').level === 'info' && !codes(cs).includes('airspace@0') && /Departure in KGYR Class D/.test(cs.find((c) => c.code === 'terminal').text), JSON.stringify(cs.filter((c) => c.code === 'terminal')));
  cs = S.checks({ log: { rows: [mkRow({}), mkRow({})] }, airports: LATA, dep: 'KGEU', dest: 'KGYR', conflicts: [[], [gyrD]] });
  tst('arrival surface area is one info', cs.filter((c) => c.code === 'terminal').length === 1 && /Arrival in KGYR/.test(cs.find((c) => c.code === 'terminal').text));
  cs = S.checks({ log: { rows: [mkRow({}), mkRow({})] }, airports: LATA, dep: 'KGEU', dest: 'KGEU', conflicts: [[], [gyrD]] });
  tst('surface area of another airport mid-route still warns', cs.some((c) => c.code === 'airspace' && c.level === 'warn'));
  const tagged = S.airspaceConflicts({ lat: 33, lon: -112.0 }, { lat: 33, lon: -112.1 }, S.legProfile([{ dist: Nav.dist({ lat: 33, lon: -112.0 }, { lat: 33, lon: -112.1 }), alt: 2000, prevAlt: 2000, last: false }])[0],
    [{ name: 'SOME CLASS D', cls: 'D', lowerFt: 0, upperFt: 3000, lowerRef: 'SFC', rings: [[[32.9, -112.2], [33.1, -112.2], [33.1, -111.9], [32.9, -111.9]]] }], { airports: [{ ident: 'KXYZ', lat: 33.0, lon: -112.05 }] });
  tst('airspaceConflicts tags a conflict whose polygon holds the airport', tagged.length === 1 && tagged[0].ap === 'KXYZ');
  cs = S.checks({ log: { rows: [mkRow({})] }, conflicts: [[inB(0, 0, 7.2, 14, 4000), inB(0, 0, 14.4, 19, 3000), inB(0, 0, 19.4, 31.3, 0),
    { name: 'PHOENIX CLASS B', cls: 'B', lowerFt: 7000, upperFt: 9000, lowerRef: 'MSL', fromNm: 0, toNm: 4, kind: 'under-shelf' }, { name: 'PHOENIX CLASS B', cls: 'B', lowerFt: 6000, upperFt: 9000, lowerRef: 'MSL', fromNm: 4.2, toNm: 7, kind: 'under-shelf' }]] });
  const asx = cs.filter((c) => c.code === 'airspace');
  tst('one warn per leg and class with merged floors, one shelf info', asx.length === 2 && asx[0].level === 'warn' && /7\.2-31\.3 NM \(floors 4000\/3000\/SFC\)/.test(asx[0].text) && asx[1].level === 'info' && /lowest floor 6000/.test(asx[1].text), JSON.stringify(asx));
  tst('glide gap under 3 NM is info, 3 NM or more is warn', S.checks({ log: { rows: [mkRow({})] }, glide: [{ fields: [], gaps: [{ fromNm: 1, toNm: 3.5 }] }] }).find((c) => c.code === 'glideGap').level === 'info'
    && S.checks({ log: { rows: [mkRow({})] }, glide: [{ fields: [], gaps: [{ fromNm: 1, toNm: 4 }] }] }).find((c) => c.code === 'glideGap').level === 'warn');
  cs = S.checks({ log: { rows: [mkRow({})] }, airports: LATA, solo: true, night: true, dep: 'KGYR', dest: 'E63' });
  tst('KE63 not approved for night VFR', codes(cs).includes('aptNight') && cs.find((c) => c.code === 'aptNight').text.includes('E63'), codes(cs).join());
  tst('KGYR departure without ATO procedure', codes(cs).includes('noAtoProc@0'));
  cs = S.checks({ log: { rows: [mkRow({ fixed: { min: 4, nm: 7 } })] }, airports: LATA, solo: true, night: false, dep: 'KGYR', dest: 'KGEU' });
  tst('KGYR departure with ATO procedure is fine', !codes(cs).includes('noAtoProc@0'));
  tst('SOW limits are listed as info', codes(S.checks({ log: { rows: [mkRow({})] }, airports: LATA, dest: 'KSOW', dep: 'KGEU', solo: false })).includes('aptLimits'));
  eq('checks with nothing', S.checks({}).length + S.checks().length, 0, 0);

  // recommender
  const leg = { a: A0, b: B0, mc: 90, dist: lenAB };
  const env = { msa: 6000, airspaces: [shelf], winds: () => ({ dir: 90, spd: 20 }), cruise: (alt) => ({ tas: 140 + alt / 1000, ff: 12.7 }), minFt: 3000, maxFt: 12500 };
  const ra = S.recommendAlts(leg, env);
  tst('recommender: no altitude below MSA is ok', ra.filter((r) => r.alt < 6000).every((r) => !r.ok) && ra.some((r) => r.alt < 6000));
  tst('recommender: shelf altitudes rejected, 9500 is the first ok, all semicircular', ra.filter((r) => r.alt < 9000).every((r) => !r.ok) && ra.find((r) => r.ok).alt === 9500 && ra.every((r) => Nav.semicircularOk(90, r.alt, 0)), JSON.stringify(ra.map((r) => r.alt + ':' + r.ok)));
  const rec = ra.filter((r) => r.rec);
  tst('recommender: exactly one rec, lowest ok', rec.length === 1 && rec[0].alt === ra.find((r) => r.ok).alt && rec[0].gs > 100 && rec[0].fuel > 0, JSON.stringify(ra.slice(0, 3)));
  tst('recommender with no data does not throw', S.recommendAlts({ mc: 90, dist: 10 }, {}).every((r) => !r.ok) && Array.isArray(S.recommendAlts(null, null)));
  tst('recommender: wind too strong is not ok', S.recommendAlts({ mc: 90, dist: 10 }, { cruise: () => ({ tas: 100, ff: 10 }), winds: () => ({ dir: 0, spd: 150 }) }).every((r) => !r.ok));
}
// OfpData against a network that is down: every call resolves {ok:false}, never throws, never zero. Child process
// because test.js exits synchronously.
{
  const out = require('child_process').execFileSync(process.execPath, ['-e', `
    global.fetch = () => Promise.reject(new Error('offline'));
    const D = require('./ofpdata.js'); const bb = { s: 33.2, w: -112.8, n: 33.7, e: -111.9 };
    Promise.all([D.airspace(bb), D.airports(bb), D.navaids(bb), D.obstacles(bb), D.terrainMax({ lat: 33.4, lon: -112.7 }, { lat: 33.4, lon: -112.0 }), D.windsAloft({ lat: 33.4, lon: -112, timeMs: Date.now(), altFt: 6000 }), D.airspace(null)])
      .then((r) => console.log(JSON.stringify(r.map((x) => [x.ok, x.at, x.data === null || (Array.isArray(x.data) && x.data.length === 0)]))));
  `], { cwd: __dirname }).toString().trim();
  const r = JSON.parse(out);
  const allDown = r.length === 7 && r.every((x) => x[0] === false && x[1] === null && x[2] === true);
  console.log((allDown ? 'ok   ' : 'FAIL ') + 'OfpData offline: all sources ok:false with empty data ' + out); if (!allDown) fail++;
  const D = require('./ofpdata.js');
  const u = D._urls.addsUrl('Class_Airspace', { s: 33.2, w: -112.8, n: 33.7, e: -111.9 }, '1=1', 'NAME', 'poly');
  console.log((/Class_Airspace\/FeatureServer\/0\/query\?/.test(u) && /geometry=-112\.8%2C33\.2%2C-111\.9%2C33\.7/.test(u) && /inSR=4326/.test(u) && /maxAllowableOffset/.test(u) ? 'ok   ' : 'FAIL ') + 'OfpData ADDS query url'); if (!/maxAllowableOffset/.test(u)) fail++;
  // Open-Meteo pressure levels -> wind (levels at 2.5k/5k/10k/14k ft ~ 762/1500/3050/4270 m)
  const mk = (gh, d, s, tc) => ({ gh, d, s, tc });
  const L = { 925: mk(762, 200, 10, 20), 850: mk(1500, 220, 20, 14), 700: mk(3050, 250, 40, 0), 600: mk(4270, 260, 50, -10) };
  const hourly = { time: [1000, 4600] };
  [1000, 925, 850, 800, 700, 600, 500].forEach((l) => { const o = L[l]; hourly['wind_speed_' + l + 'hPa'] = o ? [o.s, o.s] : [null, null]; hourly['wind_direction_' + l + 'hPa'] = o ? [o.d, o.d] : [null, null]; hourly['temperature_' + l + 'hPa'] = o ? [o.tc, o.tc] : [null, null]; hourly['geopotential_height_' + l + 'hPa'] = o ? [o.gh, o.gh] : [null, null]; });
  const ow = D._omWind({ hourly }, 1000 * 1000, 1500 * 3.28084);
  eq('Open-Meteo wind at a level', ow.spd, 20, 0); eq('Open-Meteo wind dir', ow.dir, 220, 0); eq('Open-Meteo temp', ow.tempC, 14, 0.2);
  eq('Open-Meteo wind between levels', D._omWind({ hourly }, 1000 * 1000, 2275 * 3.28084).spd, 30, 1.2);
  eq('Open-Meteo empty response is null', D._omWind({}, 0, 5000) === null && D._omWind(null, 0, 5000) === null ? 1 : 0, 1, 0);
}
// ==== end safety ====
console.log(fail ? fail + ' FAILED' : 'ALL PASS'); process.exit(fail ? 1 : 0);
