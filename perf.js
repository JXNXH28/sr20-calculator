// SR20 performance + weight & balance (LAT PA THB DE.ATO.018 Rev 06, 15Aug2026).
// Classic script (works from file://) and CommonJS (node test.js).
(function (root) {
'use strict';

/* ---------------- tables ---------------- */
const TEMPS = [0, 10, 20, 30, 40, 50];
const PAS = [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000];

const TO = {
  3150: {
    gr: [[1503,1623,1748,1877,2011,2150],[1653,1784,1921,2063,2210,2363],[1818,1962,2133,2269,2431,2599],[2002,2161,2326,2498,2676,2862],[2206,2381,2563,2753,2950,3154],[2433,2626,2827,3037,3254,3479],[2687,2900,3122,3353,3592,3841],[2969,3205,3450,3705,3970,4245],[3322,3586,3861,4146,4442,4750],[3752,4050,4360,4682,5017,5364],[4240,4577,4927,5291,5670,6062]],
    tot: [[2273,2443,2618,2799,2986,3179],[2491,2675,2867,3065,3270,3482],[2730,2932,3142,3359,3584,3817],[2995,3217,3447,3686,3932,4187],[3288,3532,3785,4048,4319,4599],[3614,3883,4161,4449,4747,5055],[3976,4272,4578,4895,5224,5563],[4379,4705,5042,5392,5754,6127],[4883,5246,5622,6013,6416,6833],[5495,5904,6328,6767,7221,7691],[6188,6649,7127,7621,8133,8663]]
  },
  2600: {
    gr: [[913,986,1061,1140,1221,1305],[1004,1083,1166,1252,1342,1435],[1104,1192,1283,1378,1476,1578],[1215,1312,1412,1517,1625,1738],[1339,1446,1556,1671,1791,1915],[1477,1595,1717,1844,1975,2112],[1631,1761,1896,2036,2181,2332],[1803,1946,2095,2250,2411,2577],[2017,2178,2344,2518,2697,2884],[2278,2459,2647,2843,3046,3257],[2575,2779,2992,3213,3442,3681]],
    tot: [[1408,1513,1621,1732,1848,1967],[1542,1656,1775,1897,2024,2154],[1690,1815,1945,2079,2218,2361],[1854,1991,2133,2281,2433,2590],[2036,2186,2342,2504,2672,2844],[2237,2403,2574,2752,2936,3126],[2461,2643,2832,3028,3230,3440],[2710,2911,3119,3335,3558,3788],[3021,3245,3477,3718,3967,4224],[3399,3651,3913,4184,4464,4754],[3827,4112,4406,4711,5027,5353]]
  }
};

// Landing, 3150 lb, by flaps %
const LAND = {
  100: {
    gr: [[809,838,868,897,927,957],[838,869,900,931,961,992],[870,901,933,965,997,1029],[902,935,968,1001,1034,1067],[936,971,1005,1039,1073,1108],[972,1007,1043,1079,1114,1150],[1009,1046,1083,1120,1157,1194],[1048,1086,1125,1163,1201,1240],[1089,1128,1168,1208,1248,1288],[1131,1173,1214,1255,1297,1338],[1176,1219,1262,1305,1348,1391]],
    tot: [[2557,2609,2663,2717,2773,2829],[2610,2665,2722,2779,2838,2898],[2666,2725,2785,2846,2907,2970],[2726,2788,2852,2916,2981,3048],[2790,2856,2923,2991,3060,3130],[2858,2928,2999,3070,3143,3217],[2931,3004,3079,3155,3232,3310],[3008,3086,3165,3245,3326,3409],[3091,3173,3256,3341,3427,3513],[3179,3265,3353,3443,3533,3625],[3272,3364,3457,3551,3646,3743]]
  },
  50: {
    gr: [[1029,1066,1104,1141,1179,1217],[1067,1106,1145,1184,1223,1262],[1106,1147,1187,1228,1268,1309],[1148,1190,1232,1274,1316,1358],[1191,1234,1278,1322,1365,1409],[1236,1281,1327,1372,1417,1462],[1283,1330,1377,1424,1471,1518],[1333,1382,1431,1479,1528,1577],[1385,1435,1486,1537,1587,1638],[1439,1492,1544,1597,1650,1702],[1496,1550,1605,1660,1715,1769]],
    tot: [[2704,2768,2833,2899,2966,3033],[2768,2836,2904,2974,3044,3115],[2837,2908,2980,3053,3127,3202],[2909,2984,3060,3137,3216,3295],[2987,3066,3146,3227,3309,3392],[3069,3152,3236,3322,3408,3496],[3156,3243,3332,3422,3513,3605],[3248,3340,3434,3529,3624,3721],[3346,3443,3542,3642,3742,3844],[3450,3553,3656,3761,3867,3974],[3560,3668,3778,3888,4000,4112]]
  },
  0: {
    gr: [[1185,1228,1272,1315,1358,1402],[1229,1274,1319,1364,1409,1454],[1274,1321,1368,1414,1461,1508],[1322,1371,1419,1467,1516,1564],[1372,1422,1472,1523,1573,1623],[1424,1476,1528,1581,1633,1685],[1479,1533,1587,1641,1695,1749],[1536,1592,1648,1704,1760,1817],[1595,1654,1712,1770,1829,1887],[1658,1718,1779,1840,1900,1961],[1723,1786,1849,1912,1975,2038]],
    tot: [[2971,3037,3105,3174,3243,3314],[3038,3108,3179,3252,3325,3399],[3109,3183,3258,3335,3412,3490],[3185,3263,3342,3422,3504,3586],[3265,3348,3431,3515,3601,3688],[3351,3437,3525,3614,3704,3795],[3441,3533,3625,3719,3814,3910],[3537,3634,3731,3830,3930,4031],[3640,3741,3844,3948,4053,4159],[3748,3855,3963,4073,4183,4295],[3863,3976,4090,4205,4322,4439]]
  }
};

// Takeoff climb (flaps 50%): temps -20,0,20,40,50 ; PA 0..10000 step 2000
const ROC_T = [-20, 0, 20, 40, 50];
const ROC_PA = [0, 2000, 4000, 6000, 8000, 10000];
const ROC_VY = [88, 87, 86, 86, 85, 84];
const ROC = {
  3150: [[862,816,769,721,698],[752,706,658,610,586],[643,595,547,498,474],[533,485,435,386,361],[423,374,323,273,248],[313,262,211,160,134]],
  2600: [[1159,1109,1056,1003,976],[1033,981,928,874,847],[906,854,800,745,718],[780,726,671,616,589],[654,599,543,487,459],[527,471,415,358,329]]
};

// weight, VR, VLOF, VREF flaps 0/50/100
const SPEEDS = [
  [2600,65,68,79,74,71],[2700,66,69,81,76,72],[2800,67,71,82,77,74],[2900,68,72,83,78,75],
  [3000,69,73,85,80,76],[3100,70,74,86,81,77],[3150,71,75,87,82,78]
];

const FF_ALT = [0, 4000, 8000, 12000, 16000];
const FF_GPH = [20, 18, 16, 15, 13];

const SLOPE_PA = [0, 5000, 10000];
const TO_UP = [22, 30, 43];     // % of ground roll per 1% upslope
const TO_DOWN = [7, 10, 14];    // % of ground roll reduction per 1% downslope

/* ---------------- load sheet constants ---------------- */
const ARM = { s12: 143.5, s34: 180.0, bag: 208.0, fuel: 153.75 };
const LB_PER_USG = 6;
const MAX = { tom: 3150, lm: 3150, bag: 130, fuelUSG: 56 };
// Envelope corners read off the form chart: [moment/1000, lb]
const ENVELOPE = [[303, 2200], [325, 2200], [466, 3150], [444, 3150]];

/* ---------------- helpers ---------------- */
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const isNum = (x) => typeof x === 'number' && isFinite(x);

// piecewise-linear interpolation, clamped to the table ends
function lerp1(xs, ys, x) {
  x = clamp(x, xs[0], xs[xs.length - 1]);
  let i = 1;
  while (i < xs.length - 1 && x > xs[i]) i++;
  return ys[i - 1] + (ys[i] - ys[i - 1]) * (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
}
// grid[row][col], rows along rAxis, cols along cAxis
function bilerp(rAxis, cAxis, grid, r, c) {
  return lerp1(rAxis, grid.map((row) => lerp1(cAxis, row, c)), r);
}

function pressureAlt(elev, qnh) {
  if (!isNum(elev) || !isNum(qnh)) return NaN;
  return qnh > 80 ? elev + (1013 - qnh) * 30 : elev + (29.92 - qnh) * 1000; // 30 ft/hPa = 1000 ft/inHg
}
const isaTemp = (pa) => 15 - 2 * pa / 1000;
const densityAlt = (pa, oat) => pa + 120 * (oat - isaTemp(pa));

// Wind relative to runway. head>0 headwind, <0 tailwind; cross>0 from right.
// Headwind uses steady wind, tailwind/crosswind use gust (conservative).
function windComponents(dir, spd, gust, hdg, vrbWorst = true) {
  if (!isNum(dir) && isNum(spd) && isNum(hdg)) { // variable wind: assume the worst, full tailwind and full crosswind
    if (!vrbWorst) return { head: 0, cross: 0, angle: 0, vrb: true };
    const g = Math.max(isNum(gust) ? gust : 0, spd);
    return { head: -g, cross: g, angle: 0, vrb: true };
  }
  if (!isNum(dir) || !isNum(spd) || !isNum(hdg)) return null;
  const g = Math.max(isNum(gust) ? gust : 0, spd);
  const ang = ((dir - hdg) % 360 + 540) % 360 - 180;
  const r = ang * Math.PI / 180;
  const steady = spd * Math.cos(r);
  return { head: steady >= 0 ? steady : g * Math.cos(r), cross: g * Math.sin(r), angle: ang };
}
function windFactor(head, kPerTenHW) {
  return head >= 0 ? 1 - 0.1 * head / kPerTenHW : 1 + 0.1 * (-head) / 2;
}

// Table rows with weight >= w (no interpolation). Below 2600 -> 2600.
function speedRow(w) {
  for (const r of SPEEDS) if (r[0] >= w) return r;
  return SPEEDS[SPEEDS.length - 1];
}

/* ---------------- takeoff ---------------- */
function takeoff(i) {
  const o = { warn: [] };
  const pa = pressureAlt(i.elev, i.qnh);
  o.pa = pa;
  if (isNum(pa) && isNum(i.oat)) { o.isa = isaTemp(pa); o.da = densityAlt(pa, i.oat); }
  if (isNum(o.da)) o.ff = lerp1(FF_ALT, FF_GPH, o.da);
  const w = i.tow;
  if (isNum(w)) {
    const row = speedRow(w);
    o.vr = row[1]; o.vlof = row[2];
    if (w > 3150) o.warn.push('Takeoff weight above 3150 lb');
  }
  const wc = windComponents(i.wdir, i.wspd, i.wgust, i.hdg, i.vrbWorst !== false);
  o.wind = wc;
  if (wc) {
    o.head = wc.head; o.cross = wc.cross;
    if (wc.head < -10) o.warn.push('Tailwind above 10 kt – beyond handbook data');
  }
  if (isNum(pa) && isNum(i.oat) && isNum(w)) {
    if (pa > 10000) o.warn.push('Pressure altitude above table (10000 ft)');
    if (i.oat > 50) o.warn.push('OAT above table (50 °C) – use caution');
    const tbl = w <= 2600 ? 2600 : 3150; // no weight interpolation: next higher table weight (conservative)
    const at = (set) => bilerp(PAS, TEMPS, TO[tbl][set], pa, i.oat);
    let gr = at('gr'), tot = at('tot');
    const wf = windFactor(wc ? wc.head : 0, 12);
    gr *= wf; tot *= wf;
    const slope = isNum(i.slope) ? i.slope : 0;
    let pct = slope >= 0 ? lerp1(SLOPE_PA, TO_UP, pa) * slope : -lerp1(SLOPE_PA, TO_DOWN, pa) * -slope;
    if (i.surf === 'dry') pct += 15;
    if (i.surf === 'wet') o.warn.push('No takeoff data for wet grass');
    const add = gr * pct / 100;
    gr += add; tot += add;
    if (i.ac) { gr += 300; tot += 400; }
    o.tor = gr; o.tod = tot;
    if (isNum(i.len) && tot > i.len) o.warn.push('Takeoff distance over 50 ft exceeds runway length');
  }
  if (isNum(pa) && isNum(i.oat) && isNum(w)) {
    const wt = clamp(w, 2600, 3150);
    let roc = lerp1([2600, 3150], [bilerp(ROC_PA, ROC_T, ROC[2600], pa, i.oat), bilerp(ROC_PA, ROC_T, ROC[3150], pa, i.oat)], wt);
    if (i.ac) roc -= 75;
    o.roc = roc;
  }
  if (isNum(pa)) {
    o.vy = lerp1(ROC_PA, ROC_VY, pa);
    if (wc && isNum(o.da)) {
      const tas = o.vy * (1 + 0.02 * o.da / 1000);
      o.wca = Math.asin(clamp(wc.cross / tas, -1, 1)) * 180 / Math.PI;
    }
  }
  return o;
}

/* ---------------- landing ---------------- */
function landing(i) {
  const o = { warn: [] };
  const pa = pressureAlt(i.elev, i.qnh);
  o.pa = pa;
  const w = i.w;
  if (isNum(w)) {
    const idx = i.flaps === 0 ? 3 : i.flaps === 50 ? 4 : 5;
    o.vref = speedRow(w)[idx];
    if (w > 3150) o.warn.push('Landing weight above 3150 lb');
    const wc = windComponents(i.wdir, i.wspd, i.wgust, i.hdg, i.vrbWorst !== false);
    o.wind = wc;
    const half = Math.max(0, ((isNum(i.wgust) ? i.wgust : 0) - (isNum(i.wspd) ? i.wspd : 0)) / 2);
    o.vtgt = Math.round(o.vref + half);
    if (wc) o.head = wc.head, o.cross = wc.cross;
    if (wc && wc.head < -10) o.warn.push('Landing tailwind above 10 kt – beyond handbook data');
    if (isNum(pa) && isNum(i.oat)) {
      if (pa > 10000) o.warn.push('Landing: pressure altitude above table');
      if (i.oat > 50) o.warn.push('Landing: OAT above table – use caution');
      const t = LAND[i.flaps];
      let gr = bilerp(PAS, TEMPS, t.gr, pa, i.oat), tot = bilerp(PAS, TEMPS, t.tot, pa, i.oat);
      const wf = windFactor(wc ? wc.head : 0, 13);
      gr *= wf; tot *= wf;
      const slope = isNum(i.slope) ? i.slope : 0;
      let pct = slope < 0 ? 27 * -slope : -9 * slope; // downslope increases
      if (i.surf === 'dry') pct += 20;
      if (i.surf === 'wet') pct += 60;
      const add = gr * pct / 100;
      o.gr = gr + add; o.tot = tot + add;
      if (isNum(i.len) && o.tot > i.len) o.warn.push('Landing distance over 50 ft exceeds runway length');
    }
  }
  return o;
}

/* ---------------- mass & balance ---------------- */
function inPoly(pt, poly) {
  let c = false;
  for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
    const [xa, ya] = poly[a], [xb, yb] = poly[b];
    if ((ya > pt[1]) !== (yb > pt[1]) && pt[0] < (xb - xa) * (pt[1] - ya) / (yb - ya) + xa) c = !c;
  }
  return c;
}

function loadSheet(i) {
  const o = { warn: [], rows: {} };
  const n = (x) => (isNum(x) ? x : 0);
  const bag = n(i.bag);
  const fTO = n(i.fuelTO), fTrip = n(i.fuelTrip);
  const w = {
    bem: i.bem, s12: n(i.w1) + n(i.w2), s34: n(i.w3) + n(i.w4), bag,
    fuelTO: fTO * LB_PER_USG, trip: fTrip * LB_PER_USG
  };
  const mom = (lb, arm) => lb * arm / 1000;
  const m = { bem: i.bemMom, s12: mom(w.s12, ARM.s12), s34: mom(w.s34, ARM.s34), bag: mom(w.bag, ARM.bag), fuelTO: mom(w.fuelTO, ARM.fuel), trip: mom(w.trip, ARM.fuel) };
  o.w = w; o.m = m;
  if (!isNum(w.bem)) return o;
  const zfm = w.bem + w.s12 + w.s34 + w.bag;
  const tom = zfm + w.fuelTO;
  const lm = tom - w.trip;
  o.zfm = zfm; o.tom = tom; o.lm = lm;
  if (isNum(m.bem)) {
    const c1 = m.bem + m.s12, c2 = c1 + m.s34, c3 = c2 + m.bag, c4 = c3 + m.fuelTO, c5 = c4 - m.trip;
    o.cum = { bem: m.bem, s12: c1, s34: c2, bag: c3, zfm: c3, fuel: c4, tom: c4, lm: c5 };
    o.mz = c3; o.mt = c4; o.ml = c5;
    o.inside = { zfm: inPoly([c3, zfm], ENVELOPE), tom: inPoly([c4, tom], ENVELOPE), lm: inPoly([c5, lm], ENVELOPE) };
    if (!o.inside.zfm) o.warn.push('Zero fuel mass / CG outside envelope');
    if (!o.inside.tom) o.warn.push('Takeoff mass / CG outside envelope');
    if (!o.inside.lm) o.warn.push('Landing mass / CG outside envelope');
  }
  if (tom > MAX.tom) o.warn.push('Takeoff mass exceeds 3150 lb');
  if (lm > MAX.lm) o.warn.push('Landing mass exceeds 3150 lb');
  if (w.bag > MAX.bag) o.warn.push('Baggage exceeds 130 lb');
  if (fTO > MAX.fuelUSG) o.warn.push('Takeoff fuel exceeds 56 USG');
  if (fTrip > fTO) o.warn.push('Trip fuel exceeds takeoff fuel');
  return o;
}

const Perf = { TO, LAND, ROC, SPEEDS, ENVELOPE, ARM, MAX, LB_PER_USG, lerp1, bilerp, pressureAlt, isaTemp, densityAlt, windComponents, speedRow, takeoff, landing, loadSheet, inPoly, isNum };
if (typeof module !== 'undefined' && module.exports) module.exports = Perf; else root.Perf = Perf;
})(this);
