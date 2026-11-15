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
eq('PA 900 / 21C -> DA ~1800', P.densityAlt(900, 21), 1836, 40);
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
eq('ROC 3150 SL 0C', P.takeoff({ elev: 0, qnh: 29.92, oat: 0, tow: 3150 }).roc, 816);
// QNH hPa
eq('PA hPa', P.pressureAlt(1000, 1003), 1300);
// envelope
const ls = P.loadSheet({ bem: 2250, bemMom: 318, w1: 170, w2: 0, w3: 0, w4: 0, bag: 0, fuelTO: 40, fuelTrip: 20 });
console.log(JSON.stringify({ zfm: ls.zfm, tom: ls.tom, lm: ls.lm, mt: ls.mt, inside: ls.inside, warn: ls.warn }));
eq('TOM', ls.tom, 2250 + 170 + 240);
const bad = P.loadSheet({ bem: 2250, bemMom: 300, w1: 0, fuelTO: 0 });
console.log(bad.inside.zfm === false ? 'ok   outside detected' : 'FAIL outside'); if (bad.inside.zfm !== false) fail++;
console.log(fail ? fail + ' FAILED' : 'ALL PASS'); process.exit(fail ? 1 : 0);
