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
const pTaf = W.pickWeather({ metars: [], taf: { ...taf, validTimeFrom: future - 10, validTimeTo: future + 86400, fcsts: [{ timeFrom: future - 10, timeTo: future + 86400, wdir: 20, wspd: 7, wgst: null }] }, om: om2, t: future, unit: 'inHg' });
console.log(/^TAF/.test(pTaf.wind.src) ? 'ok   TAF wind when valid' : 'FAIL TAF'); if (!/^TAF/.test(pTaf.wind.src)) fail++;
eq('model temp with TAF', pTaf.temp.v, 10, 0); eq('model QNH inHg', pTaf.qnh.v, 29.59, 0.01);
const pMod = W.pickWeather({ metars: [], taf: null, om: om2, t: future + 1800, unit: 'hPa' });
console.log(/^model/.test(pMod.wind.src) ? 'ok   model wind without TAF' : 'FAIL model'); if (!/^model/.test(pMod.wind.src)) fail++;
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
console.log(fail ? fail + ' FAILED' : 'ALL PASS'); process.exit(fail ? 1 : 0);
