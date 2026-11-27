// LAT ATO departure/arrival procedures (FF Plate Binder, Jan 23 / Oct 26 / Sep 2025 plates) with the
// B02 time and distance table (Sep 26 briefing, p42 "Exit and Entry Points at GYR").
// gate: the B02 exit point (dep) or entry point (arr); `point` is a legacy alias of gate.
// min/nm: time (whole min) and distance (NM) from the airport to the exit point (dep) or from the entry point
// to the airport (arr). null = B02 gives none, the leg then falls back to the wind triangle.
// extraMin: minutes B02 adds on top (+10 for a full-stop arrival into KGYR for pattern entry and landing).
// extraMinDest: extra minutes only when the flight ends at that airport (Power Plant DEP into KGEU: +10).
// alt: altitude (ft MSL) at the gate per the plate, null if the plate gives none.
// transitions: named en-route continuations from the plate, each an ordered list of landmarks
// { name, alt } (alt = plate altitude at/after that point, the "at or above" value where the plate says so).
// Route order: departure = gate, then transition points (away from the airport);
// arrival = transition points (toward the airport), then the gate.
// Pattern entry / runway details inside the fixed B02 segment stay in notes.
// Points have no coordinates here: an admin places them (waypoints table, owner null), see ATO.usable.
// Admin overrides (Supabase rows) are applied with ATO.merge. Verify against the current plates and B02.
(function (root) {
'use strict';
const BIN = 'FF Plate Binder p';

// ---------- normalisation (also used for admin-edited JSON)
const num = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
};
const str = (v) => (v === null || v === undefined ? '' : String(v)).trim();
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const shortOf = (s) => str(s).toUpperCase().replace(/[^A-Z0-9]+/g, '');

const normPoint = (pt) => {
  if (typeof pt === 'string') pt = { name: pt };
  if (Array.isArray(pt)) pt = { name: pt[0], alt: pt[1] };
  if (!isObj(pt)) return null;
  const name = str(pt.name);
  return name ? { name: name, alt: num(pt.alt) } : null;
};

const normalize = (p) => {
  p = isObj(p) ? p : {};
  const id = str(p.id), gate = str(p.gate !== undefined && p.gate !== null && p.gate !== '' ? p.gate : p.point);
  const xmd = {};
  if (isObj(p.extraMinDest)) Object.keys(p.extraMinDest).forEach((k) => { const v = num(p.extraMinDest[k]); if (v !== null) xmd[str(k).toUpperCase()] = v; });
  const used = new Set();
  const transitions = (Array.isArray(p.transitions) ? p.transitions : []).filter(isObj).map((t, i) => {
    let tid = str(t.id);
    if (!tid) tid = id + '.' + (shortOf(t.name) || 'T' + (i + 1));
    while (used.has(tid)) tid += '_' + (i + 1);
    used.add(tid);
    return {
      id: tid, name: str(t.name) || tid, dualOnly: !!t.dualOnly, soloOnly: !!t.soloOnly, notes: str(t.notes),
      points: (Array.isArray(t.points) ? t.points : []).map(normPoint).filter(Boolean),
    };
  });
  return {
    id: id, airport: str(p.airport).toUpperCase(), kind: p.kind === 'arr' ? 'arr' : 'dep', name: str(p.name) || id,
    gate: gate, point: gate, min: num(p.min), nm: num(p.nm), alt: num(p.alt),
    dualOnly: !!p.dualOnly, soloOnly: !!p.soloOnly, extraMin: num(p.extraMin) || 0, extraMinDest: xmd,
    plate: str(p.plate), notes: str(p.notes), transitions: transitions,
  };
};

// ---------- defaults from the plates
const T = (short, name, points, o, notes) => Object.assign({ short: short, name: name, points: points, notes: notes || '' }, o || {});
const mk = (id, airport, kind, name, gate, min, nm, alt, o, plate, notes, trs) => {
  const p = normalize(Object.assign({
    id: id, airport: airport, kind: kind, name: name, gate: gate, min: min, nm: nm, alt: alt,
    plate: BIN + plate, notes: notes || '',
    transitions: (trs || []).map((t) => ({ id: id + '.' + t.short, name: t.name, dualOnly: t.dualOnly, soloOnly: t.soloOnly, notes: t.notes, points: t.points })),
  }, o || {}));
  return p;
};
const FS = { extraMin: 10 }; // B02: all full-stop arrivals into KGYR, +10 min for pattern entry and landing
const DUAL = { dualOnly: true }; // '(SOLO)' on a plate marks an approved solo route, not a solo-only restriction: it stays in the notes

const procedures = [
  // ---- KGYR departures (B02 exit points)
  mk('GYR-DEP-GILACROSSING', 'KGYR', 'dep', 'Gila Crossing DEP', 'PIR', 5, 5, 2700, null, 4,
    'RWY 21: 2000 or Gila River, then 2700 left downwind, abeam the tower ~120 to 1 NM NE of PIR; RWY 3: 2000/Litchfield Rd then 2700 to pass 1 NM NE of PIR. Do not overfly PIR. Fly ~130 at 2700 until 1 NM SW of Gila Crossing, then on course. Keep KGYR tower until abeam Gila Crossing, then monitor 122.85.', [
      T('CHD', 'Chandler', [['GILA CROSSING 1NM SW', 2700], ['NORTH TEST TRACK', 3500], ['SUN LAKES', 3500]], null,
        'Pass 1 NM SW of Gila Crossing at 2700, on course to the North Test Track (3500), then ~013 toward Sun Lakes for the arrival into KCHD from the south. Maintain at or below 5500.'),
      T('IWA', 'Gateway', [['GILA CROSSING 1NM SW', 2700], ['NORTH TEST TRACK', 3500]], null,
        'Pass 1 NM SW of Gila Crossing at 2700, on course to the North Test Track, then ~030 inbound on IWA R-210 below 5500 while descending to 3000 for the arrival into KIWA.'),
      T('OTH', 'All Others', [['GILA CROSSING 1NM SW', 2700]], null,
        'Pass 1 NM SW of Gila Crossing at 2700, then climb on course. Use caution to avoid penetration of Class B.'),
    ]),
  mk('GYR-DEP-BUCKEYE', 'KGYR', 'dep', 'Buckeye DEP', 'LIBERTY BRIDGE', 4, 7, 2000, null, 1,
    'RWY 21: runway heading to the Gila River, right turn along the river climbing 2000; RWY 3: 1700, crosswind/downwind to 2500, descend 2000 at the river. Track the Gila River (~248) at 2000 until south of KBXK. Keep KGYR tower until Liberty Bridge, then 128.92 until SR 85, then KBXK CTAF until west of BXK VOR. Avoid Palo Verde by 3 NM.', [
      T('BXK', 'Buckeye Airport', [], null, 'Maintain 2000 and maneuver for the 4 mile 45 degree entry for RWY 17 or RWY 35 at KBXK.'),
      T('WEST', 'Western', [['ARLINGTON', 3000], ['HASSAYAMPA I-10', 5000]], null,
        'Start climb south of KBXK, cross Arlington at or above 3000, climb to on-course altitude northbound along the Hassayampa Wash, cross I-10 at or above 5000.'),
      T('NORTH', 'Northern', [['ARLINGTON', 3000], ['HASSAYAMPA I-10', 5000], ['PROVING GROUNDS', 5500]], null,
        'Start climb south of KBXK to 5500, cross Arlington at or above 3000, northbound over the Hassayampa Wash, cross I-10 at or above 5000 and contact Luke Approach 125.45 for traffic advisories. Maintain 5500 on course; passing the proving grounds in training area Oscar climb/descend on course.'),
      T('SW', 'Southwest', [['ARLINGTON', 3000]], null, 'Start climb south of KBXK, cross Arlington at or above 3000, climb on course.'),
      T('TON', 'Tonopah', [['ARLINGTON', 3000], ['HASSAYAMPA I-10', 5000], ['TONOPAH', 5000]], null,
        'SOLO (plate map only, no text): up the Hassayampa Wash, cross I-10 at or above 5000, then west along I-10 to Tonopah at 5000 (5500 shown north of I-10).'),
    ]),
  mk('GYR-DEP-TWINLAKES', 'KGYR', 'dep', 'Twin Lakes DEP', 'LIBERTY BRIDGE', 5, 7, 3500, null, 10,
    'RWY 21: runway heading to the Gila River, follow it ~230 to Liberty Bridge climbing 3500; RWY 3: 1700, crosswind/downwind climbing 3500 to the Gila River, then follow it to Liberty Bridge. Avoid overflying the housing around Twin Lakes. Monitor and report on 128.92 (Rainbow Valley) passing Liberty Bridge.', [
      T('BISHOP', 'Bishop', [['WATERMAN WASH 1NM SW', 3500], ['1AZ0', 3500]], null,
        'PPR required for 1AZ0 (no ops during CPS ops). Plate map marks this SOLO. ~190 from Liberty Bridge until 1 NM SW of Waterman Wash, then ~125/115 to cross 1AZ0 midfield at 3500; passing overhead climb on course or enter the pattern. Announce on 130.47 10 NM NW.'),
      T('TIREFARM', 'Tire Farm', [['WATERMAN WASH 1NM SW', 3500], ['TIRE FARM', 4500]], null,
        '~190 from Liberty Bridge until 1 NM SW of Waterman Wash, then ~150 climbing to 4500. Pass Tire Farm 1 NM SW.'),
      T('SW', 'Southwest', [], DUAL, 'DUAL ONLY. Abeam Twin Lakes climb on course.'),
    ]),
  mk('GYR-DEP-POWERPLANT', 'KGYR', 'dep', 'Power Plant DEP', 'THE STACK', 5, 6, 2700, { dualOnly: true, extraMinDest: { KGEU: 10 } }, 8,
    'DUAL ONLY. Not authorized for solo student flights. RWY 21: 2000 or Gila River, 2700 left downwind, abeam the tower ~055 to 1 NM E of the I-10/101 stack; RWY 3: 2000 or Litchfield Rd, ~070 to 1 NM E of the stack at 2700. Call KGEU tower before abeam the stack. B02: add 10 min if used for an arrival into KGEU.', [
      T('PP', 'Power Plant', [['GLENDALE POWER PLANT', 2700]], null,
        'Before the stack contact KGEU tower for the transition. ~013 at 2700 until abeam the Glendale Power Plant (pass 1 NM E), contact Luke Approach 118.15, then climb on course referencing airspace.'),
      T('GEU', 'Glendale', [], null, 'Before the I-10/101 stack contact KGEU tower and comply with directions (arrival into KGEU, +10 min).'),
    ]),
  // ---- KGYR arrivals (B02 entry points, +10 min for a full stop)
  mk('GYR-ARR-LUKEAUX6', 'KGYR', 'arr', 'Luke Aux 6 ARR', 'LUKE AUX 6', 3, 7, 2000, FS, 9,
    'Arrive 1/2 NM south of Luke Aux 6 at 2000 (all transitions arrive 1-2 NM south through west of Aux 6). Call KGYR tower 2 NM before abeam Aux 6. Then as directed: right DW RWY 21 (~075), left base RWY 3 (direct Rubbermaid ~092) or left DW RWY 3 (canal to 1 NM SW of the I-10/303 stack). Avoid Palo Verde by 3 NM; do not cross I-10.', [
      T('BISHOP', 'Bishop', [['GILA S OF LUKE AUX 6', 2000]], null,
        'Direct Luke Aux 6 at 2500 until crossing the Gila River, then descend and maintain 2000 direct 1/2 NM south of Luke Aux 6.'),
      T('BXK17', 'Buckeye RWY 17', [], null, 'From KBXK RWY 17: straight out until 2000, then ~060 direct 1/2 NM south of Luke Aux 6 at 2000.'),
      T('BXK35', 'Buckeye RWY 35', [['TARTESSO NE CORNER', 2500], ['LUKE AUX 6 1NM SW', 2000]], null,
        'From KBXK RWY 35: straight out to 3 NM north of I-10 (north boundary of Tartesso) climbing 2500. From the north side of Tartesso ~110 to ~1 NM SW of Luke Aux 6, then eastbound to 1/2 NM south. After passing the foothills descend 2000.'),
      T('NW', 'Northwest', [['HASSAYAMPA GRAVEL PIT', 3500], ['TARTESSO NE CORNER', 2500], ['LUKE AUX 6 1NM SW', 2000]], null,
        'SOLO. Contact Luke Approach 125.45 for traffic advisories. At or below 6000 passing training area O, to the gravel pit on the Hassayampa Wash, eastbound along the north boundary of Tartesso descending 3500. East of Sun Valley Pkwy 2500, ~110 to ~1 NM SW of Luke Aux 6, then eastbound; after the foothills descend 2000.'),
      T('SW', 'Southwest', [['ARLINGTON', 2500], ['FARM AG PVT', 2500]], null,
        'To 1 NM north of Arlington at 2500, 1 NM south of the railroad tracks at 2500 to the NW corner of Farm Ag Pvt, then to 1/2 NM south of Luke Aux 6 descending 2000.'),
    ]),
  mk('GYR-ARR-GAP', 'KGYR', 'arr', 'Gap ARR', 'THE GAP', 2, 5, 2500, FS, 2,
    'Arrive at the Gap at 2500, from the Gap descend and maintain 2000 and enter the pattern as directed. Call KGYR tower no closer than 4 NM south of the Gap. Report intentions to Rainbow Valley on 128.92. RWY 21: Sawed-Off Mtn then toward the tower, left DW; RWY 3: golf course 2 mile right base, or PIR then north to Lower Buckeye Rd for right DW.', [
      T('SOUTH', 'South', [], DUAL, 'DUAL ONLY. Arrive from south of the Gap at 2500 (~360).'),
      T('BISHOP', 'Bishop', [['1AZ0', 4500], ['WATERMAN WASH 1NM NE', 2500]], null,
        'PPR required for 1AZ0 (no ops during CPS ops). Cross 1AZ0 midfield at 4500, descend and maintain 2500, fly ~305 parallel 1 NM NE of Waterman Wash; when able to fly a northerly heading turn direct the Gap.'),
      T('TIREFARM', 'Tire Farm', [['TIRE FARM', 3500], ['WATERMAN WASH 1NM NE', 2500]], null,
        'Cross Tire Farm at 3500, ~350 until 1 NM NE of Waterman Wash, descend and maintain 2500 parallel to the wash; when able to fly a northerly heading turn direct the Gap.'),
    ]),
  mk('GYR-ARR-GILACROSSING', 'KGYR', 'arr', 'Gila Crossing ARR', 'GILA CROSSING', 6, 14, 2000, FS, 3,
    'Arrive 1 NM NE of Gila Crossing at 2000. Call tower abeam Gila Crossing. Left DW RWY 21 / right base RWY 3: heading 300 to 1 NM NE of PIR, then Sawed-Off Mtn; right DW RWY 3: 320 to the Lower Buckeye Rd roundabout, then parallel the road; left base RWY 21: heading 305 to the Cattle Sheds. From KGEU see the Glendale DEP (solo route) GYR Arrival transition.'),
  mk('GYR-ARR-POWERPLANT', 'KGYR', 'arr', 'Power Plant ARR', 'THE STACK', 3, 6, 2600, Object.assign({ dualOnly: true }, FS), 7,
    'DUAL ONLY. Not authorized for solo student flights. 2600 passing 1 NM west of the I-10/101 stack; crossing I-10 heading 168 to Lower Buckeye Rd and descend to 2000. Contact KGEU tower prior to the Power Plant (Class D transition), KGYR tower at the stack. RWY 21: Lower Buckeye Rd to the Cattle Sheds (2 mile left base) or PIR, Sawed-Off Mtn, tower for the 45 entry; RWY 3: parallel Lower Buckeye Rd for right downwind.', [
      T('PP', 'Power Plant', [['GLENDALE POWER PLANT', 2600]], null,
        'Arrive 1 NM west of the Glendale Power Plant at and maintain 2600, then ~193 to 1 NM west of the I-10/101 stack. Contact KGEU tower prior to the Power Plant.'),
      T('GEU', 'Glendale Airport', [], null, 'From KGEU depart direct to 1 NM west of the I-10/101 stack and maintain 2600.'),
    ]),
  // ---- KGEU (B02 gives no time or distance)
  mk('GEU-ARR-GLENDALE', 'KGEU', 'arr', 'Glendale ARR (solo route)', 'GILA CROSSING', null, null, 2100, null, 5,
    'Solos departing KGYR to KGEU fly the Gila Crossing DEP first. From 1 NM NE of Gila Crossing fly heading 325 at 2100 to 1 NM east of the Stack at Tolleson. Keep KGYR tower until passing Gila Crossing northwest bound, contact KGEU tower prior to Tolleson.', [
      T('GILA', 'Gila Crossing', [['RIGGS RD EXTENSION', 2100]], null,
        'Solo route: depart KGYR on the Gila Crossing DEP (2700) until 1 NM SW of Gila Crossing, continue SE to the western extension of Riggs Rd, turn left to 1 NM NE of Gila Crossing at 2100.'),
      T('SE', 'Southeast', [], null, 'Fly to 1 NM NE of Gila Crossing, descend and maintain 2100.'),
    ]),
  mk('GEU-DEP-GLENDALE', 'KGEU', 'dep', 'Glendale DEP (solo route)', 'GILA CROSSING', null, null, 2500, null, 6,
    'Fly 1 NM west of the Stack at Tolleson, heading 145 to abeam Gila Crossing, climb and maintain 2500. Contact KGYR tower south of I-10 and advise intentions.', [
      T('SE', 'Southeast', [], null, 'Climb on course referencing airspace.'),
      T('GYR', 'GYR Arrival', [['RIGGS RD EXTENSION', 2000]], null,
        'Solos to KGYR: abeam Gila Crossing continue SE to the western extension of Riggs Rd, turn left NE to 1 NM NE of Gila Crossing descending to 2000, then the Gila Crossing ARR.'),
    ]),
  mk('GEU-ARR-POWERPLANT', 'KGEU', 'arr', 'Glendale Transition (Power Plant DEP)', 'THE STACK', null, null, 2700, { dualOnly: true }, 8,
    'DUAL ONLY. Prior to the I-10/101 stack contact KGEU tower and comply with directions. B02 adds 10 min to the Power Plant DEP for an arrival into KGEU.'),
  mk('GEU-DEP-POWERPLANT', 'KGEU', 'dep', 'Glendale Airport Transition (Power Plant ARR)', 'THE STACK', null, null, 2600, { dualOnly: true }, 7,
    'DUAL ONLY. Depart direct to 1 NM west of the I-10/101 stack at 2600, then heading 168 to Lower Buckeye Rd.'),
  // ---- E63 (B02 gives no time or distance; arrival points are not required at off-site airports)
  mk('E63-ARR-RWY22', 'E63', 'arr', 'E63 Pattern Entry RWY 22', 'E63 TRUCK STOP', null, null, 1600, null, 11,
    'Parallel I-8 on its north side (remain north of I-8 at all times). Over the motel/truck stop maneuver for a ~1.5 NM 45 degree entry to left traffic RWY 22; do not extend upwind. Contact Gila Bend AF Aux tower (127.75) ~15 NM out for wind and altimeter; CTAF 122.80. Pattern partly inside the Gila Bend AF Aux Class D.', [
      T('NORTH', 'North', [['E63', 2600], ['BABY CAMELBACK NW', 1600]], null,
        'Cross midfield at 2600, turn toward the NW corner of Baby Camelback Mountain on an easterly heading, keep 2600 for 20 seconds then descend to 1600. Approaching the mountain turn right toward the west using the dirt road south of I-8.'),
      T('EAST', 'East', [['BABY CAMELBACK NW', 1600]], null,
        'Aim for the NW corner of Baby Camelback Mountain, keep visual separation from terrain and descend to 1600. Abeam the mountain turn SW toward I-8.'),
    ]),
  // ---- KBXK / 1AZ0 Pipeline Transition (PPR for 1AZ0)
  mk('BXK-DEP-PIPELINE', 'KBXK', 'dep', 'Pipeline Transition (to 1AZ0)', 'VOLCANO MTN', null, null, 3000, null, 12,
    'PPR required for 1AZ0. RWY 17 straight out; RWY 35 left downwind until abeam the approach end. Direct the black volcano-like mountain south of the Gila River at 3000, heading 120 to 2 NM north of the pipeline and parallel it southeast (~110), 3500 approaching 1AZ0. Report intentions to Rainbow Valley on 128.92.'),
  mk('BXK-ARR-PIPELINE', 'KBXK', 'arr', 'Pipeline Transition (from 1AZ0)', 'THE DAM', null, null, 2000, null, 13,
    'PPR for 1AZ0. Abeam the Dam on the Gila River turn north heading 350, descend and maintain 2000, then the 45 degree entries for KBXK. KBXK CTAF may be selected after crossing the Gila River westbound.'),
  mk('1AZ0-ARR-PIPELINE', '1AZ0', 'arr', 'Pipeline Transition (from KBXK)', 'WATERMAN WASH', null, null, 3500, null, 12,
    'PPR REQUIRED. Crossing Waterman Wash proceed direct to 1AZ0, climb and maintain 3500, cross midfield and enter the runway in use. Operating at or near 1AZ0 during CPS ops is PROHIBITED.'),
  mk('1AZ0-DEP-PIPELINE', '1AZ0', 'dep', 'Pipeline Transition (to KBXK)', 'TANGO', null, null, 3000, null, 13,
    'PPR REQUIRED. RWY 9: right downwind climbing 3000, midfield left ~240; RWY 27: left crosswind 3000, at 700 AGL ~215. Direct TANGO, crossing Waterman Wash climb and maintain 3500, turn right to parallel the pipeline 2 NM south. Avoid the Luke Corridor (GBN R-346 to R-360, 3500 and above). Monitor Rainbow Valley 128.92.', [
      T('BXK', 'Buckeye', [['GBN R-010 PIPELINE', 3000]], null,
        'Parallel the pipeline 2 NM south at 3500 (~285); passing GBN VOR R-010 descend and maintain 3000 (~260); abeam the Dam turn north 350 descending 2000 (Pipeline Transition from 1AZ0 into KBXK).'),
    ]),
];

const points = [
  { name: 'PIR', desc: 'Phoenix International Raceway (VPPIR), 1 NM NE of it: exit point of the Gila Crossing DEP', plate: BIN + '4' },
  { name: 'LIBERTY BRIDGE', desc: 'Bridge over the Gila River S of Buckeye, exit point of the Buckeye and Twin Lakes DEP', plate: BIN + '1, 10' },
  { name: 'THE STACK', desc: 'I-10 / Loop 101 interchange at Tolleson (pass 1 NM W arriving, 1 NM E departing), Power Plant DEP/ARR point', plate: BIN + '7, 8' },
  { name: 'LUKE AUX 6', desc: 'Luke Aux 6 auxiliary field N of Buckeye, 1/2 NM S of it: entry point of the Luke Aux 6 ARR', plate: BIN + '9' },
  { name: 'THE GAP', desc: 'Gap in the Estrella foothills south of KGYR, entry point of the Gap ARR', plate: BIN + '2' },
  { name: 'GILA CROSSING', desc: 'Gila Crossing (Gila River / Riggs Rd area, SW of South Mountain): place it 1 NM NE of Gila Crossing (Gila Crossing ARR entry, KGEU solo route)', plate: BIN + '3, 5, 6' },
  { name: 'GILA CROSSING 1NM SW', desc: '1 NM SW of Gila Crossing: the Gila Crossing DEP passes here at 2700 before going on course', plate: BIN + '4' },
  { name: 'NORTH TEST TRACK', desc: 'Oval test track E of Riggs Rd, NE of Gila Crossing (Gila Crossing DEP, Chandler/Gateway transitions)', plate: BIN + '4' },
  { name: 'SUN LAKES', desc: 'Sun Lakes community (two lakes) SW of KCHD, Chandler transition', plate: BIN + '4' },
  { name: 'ARLINGTON', desc: 'Arlington (town), south of the Gila, W of Buckeye; Buckeye DEP transitions, Luke Aux 6 ARR Southwest (1 NM N)', plate: BIN + '1, 9' },
  { name: 'HASSAYAMPA I-10', desc: 'Where the Hassayampa Wash crosses I-10, W of Buckeye (Buckeye DEP Western/Northern/Tonopah)', plate: BIN + '1' },
  { name: 'PROVING GROUNDS', desc: 'Proving grounds in training area Oscar, N of I-10 along the Hassayampa (Buckeye DEP Northern)', plate: BIN + '1' },
  { name: 'TONOPAH', desc: 'Tonopah (town) on I-10, W of the Hassayampa Wash (Buckeye DEP Tonopah, solo)', plate: BIN + '1' },
  { name: 'WATERMAN WASH 1NM SW', desc: 'Turn point 1 NM SW of Waterman Wash on the ~190 track from Liberty Bridge (Twin Lakes DEP Bishop/Tire Farm)', plate: BIN + '10' },
  { name: 'WATERMAN WASH 1NM NE', desc: 'Point 1 NM NE of Waterman Wash, where the Gap ARR Bishop/Tire Farm transitions join it at 2500', plate: BIN + '2' },
  { name: 'TIRE FARM', desc: 'Tire Farm (GBN063/D16), S of the Estrella Mtns near Waterman Wash', plate: BIN + '2, 10' },
  { name: 'GLENDALE POWER PLANT', desc: 'Glendale Power Plant on Grand Ave, NE of KGEU (pass 1 NM W arriving, 1 NM E departing)', plate: BIN + '7, 8' },
  { name: 'GILA S OF LUKE AUX 6', desc: 'Gila River crossing due south of Luke Aux 6 (Luke Aux 6 ARR Bishop: descend 2000)', plate: BIN + '9' },
  { name: 'TARTESSO NE CORNER', desc: 'NE corner of Tartesso community at Sun Valley Pkwy, ~3 NM N of I-10 (Luke Aux 6 ARR Buckeye RWY 35 / Northwest)', plate: BIN + '9' },
  { name: 'LUKE AUX 6 1NM SW', desc: 'About 1 NM SW of Luke Aux 6, turn eastbound to 1/2 NM S of Aux 6 (Luke Aux 6 ARR)', plate: BIN + '9' },
  { name: 'HASSAYAMPA GRAVEL PIT', desc: 'Gravel pit on the Hassayampa Wash N of I-10 (Luke Aux 6 ARR Northwest, solo)', plate: BIN + '9' },
  { name: 'FARM AG PVT', desc: 'NW corner of Farm Ag private strip, W of Buckeye town, S of the railroad (Luke Aux 6 ARR Southwest)', plate: BIN + '9' },
  { name: 'RIGGS RD EXTENSION', desc: 'Western extension of Riggs Rd SE of Gila Crossing, turn point of the KGEU solo routes', plate: BIN + '5, 6' },
  { name: 'BABY CAMELBACK NW', desc: 'NW corner of Baby Camelback Mountain, E of E63, north of I-8', plate: BIN + '11' },
  { name: 'E63 TRUCK STOP', desc: 'Motel/truck stop on the north side of I-8 SW of E63, start of the 45 entry RWY 22', plate: BIN + '11' },
  { name: 'VOLCANO MTN', desc: 'Black volcano-like mountain south of the Gila River (KBXK Pipeline departure)', plate: BIN + '12' },
  { name: 'THE DAM', desc: 'Dam on the Gila River S of Arlington (Pipeline Transition, KBXK arrival side)', plate: BIN + '13' },
  { name: 'WATERMAN WASH', desc: 'Waterman Wash crossing 2 NM N of the pipeline (Pipeline Transition, 1AZ0 arrival side)', plate: BIN + '12' },
  { name: 'TANGO', desc: 'East side of the Maricopa Mountains, west of Waterman Wash, 2 NM south of the pipeline', plate: BIN + '13' },
  { name: 'GBN R-010 PIPELINE', desc: 'GBN VOR R-010 crossing, 2 NM south of the pipeline (Pipeline to KBXK: descend 3000)', plate: BIN + '13' },
];

// Default positions from the AFTW landmark map (Arizona Flight Training Workgroup KML, Nov 2025). A position the admin
// places in the database overrides the default. Plate points that are AFTW landmarks get its position; GILA CROSSING
// (1 NM NE) and GILA CROSSING 1NM SW are offset 1 NM from the AFTW Gila Crossing landmark, as the plates describe.
// Not taken over: altitude/aerobatic/frequency labels, practice-area name labels and '303'.
const DEFAULT_POS = {
  'ARLINGTON': [33.32563, -112.76381],
  'GILA CROSSING': [33.28678, -112.15287],
  'GILA CROSSING 1NM SW': [33.26321, -112.18106],
  'LUKE AUX 6': [33.44089, -112.51176],
  'NORTH TEST TRACK': [33.05125, -111.93622],
  'PIR': [33.37496, -112.31680],
  'PROVING GROUNDS': [33.74850, -112.79090],
  'THE GAP': [33.34223, -112.35859],
  'TIRE FARM': [33.03377, -112.38234],
  'TONOPAH': [33.49346, -112.93747],
};
const LANDMARKS = [
  ['A MOUNTAIN', 32.21021, -110.99230], ['AGUA CALIENTE', 32.98434, -113.32370], ['AJ LANDFILL', 33.36723, -111.53085],
  ['ANTHEM', 33.85516, -112.11788], ['APACHE JUNCTION', 33.41474, -111.54970], ['AREA 51', 32.79550, -111.44492],
  ['ARIZONA CITY', 32.74826, -111.67134], ['BAPCHULE', 33.11765, -111.88647], ['BARTLETT DAM', 33.81781, -111.63178],
  ['BEELINE HIGHWAY', 33.62776, -111.55891], ['BEND IN CAREFREE', 33.80055, -112.09162], ['BIG WHITE BARN', 34.96140, -112.60226],
  ['BLACK CANYON CITY', 34.06546, -112.14260], ['BLACK MOUNTAIN NE', 33.81367, -111.94107], ['BLACK MOUNTAIN SE', 32.78464, -110.95945],
  ['BLACK MOUNTAIN TUCSON', 32.08294, -111.05734], ['BLACKWATER', 33.03048, -111.61940], ['CAMP WOOD', 34.92095, -112.87779],
  ['CAMPGROUND', 33.69470, -111.73167], ['CANYON LAKE', 33.55048, -111.43201], ['CEMENT PLANT SE', 33.25154, -111.41499],
  ['CEMENT PLANT TUCSON', 32.40966, -111.15169], ['CENTRAL AZ COLLEGE', 32.95792, -111.65350], ['CHECKERBOARD', 34.80755, -112.67568],
  ['CHINO FIELDS', 34.81089, -112.45152], ['CIRCLE CITY', 33.81488, -112.58137], ['CIRCLE FIELD', 35.05611, -112.67808],
  ['CLARKDALE CEMENT PLANT', 34.78034, -112.08403], ['CONFLUENCE', 33.54670, -111.66078], ['COOLIDGE TOWN', 32.97573, -111.52359],
  ['CORDES JUNCTION', 34.32887, -112.12117], ['COUNTRY CLUB', 34.55773, -112.26692], ['CROME PEAK', 32.72828, -111.15267],
  ['DONNELLY TRUCK STOP', 32.83305, -112.13477], ['DRAG STRIP', 33.71915, -112.47451], ['DRAKE CEMENT PLANT', 34.98073, -112.37285],
  ['DYNAMITE ROAD', 33.74128, -111.75722], ['EAGLE ROOST PRIVATE', 33.91999, -113.16777], ['EAGLETAIL PRIVATE', 33.39558, -113.22337],
  ['EL MOLINO TANK', 33.18924, -111.34110], ['FAIRGROUNDS', 34.64758, -112.27914], ['FARMS PRIVATE', 32.98874, -112.02336],
  ['FIREBIRD LAKE', 33.26920, -111.96488], ['FLORENCE', 33.03102, -111.38433], ['FLORENCE CROP CIRCLES', 33.11897, -111.41468],
  ['FLORENCE JUNCTION', 33.25560, -111.33890], ['FOUNTAIN HILLS', 33.60201, -111.71186], ['FOUR PEAKS', 33.68445, -111.32414],
  ['G.M. PRIVATE', 32.90202, -112.23776], ['GLIDERPORT', 33.80083, -112.24903], ['GOLD CANYON', 33.36004, -111.45022],
  ['GOODWIN GLIDER PORT', 34.67394, -112.30234], ['GREEN VALLEY', 31.87023, -110.98669], ['HARQ POWER PLANT', 33.47583, -113.11275],
  ['HIGHWAY 169 OVERPASS', 34.51429, -111.99228], ['HORSESHOE LAKE', 33.99952, -111.72521], ['I-10 GREENFIELDS', 33.08347, -111.81645],
  ['I-8 TOWER', 32.84383, -112.30618], ['JOHNSONS RANCH', 33.16280, -111.55994], ['KEARNY TOWN', 33.05772, -110.90887],
  ['KIRKLAND JUNCTION', 34.36996, -112.66531], ['KOMELIK MINE', 32.52369, -111.89700], ['LAKE PLEASANT MARINA', 33.85032, -112.26019],
  ['LAKE ST CLAIR', 32.64992, -111.92957], ['LAKESIDE PRISON', 33.20952, -112.65272], ['LAKESIDE PRIVATE', 33.11258, -112.66277],
  ['MARICOPA MOUNTAIN', 33.14662, -112.02008], ['MARICOPA TOWN', 33.05674, -112.04882], ['MAYER STACK', 34.39872, -112.22529],
  ['MINERAL MOUNTAIN MINE', 33.18095, -111.24819], ['MONASTARY', 32.91978, -111.26268], ['MOUNT FAGAN', 31.90005, -110.72462],
  ['MR.VOLCANO', 33.06485, -111.51487], ['NEW RIVER ROAD', 33.88244, -112.17715], ['NEWMANS PEAK', 32.72097, -111.39583],
  ['NORTH CATTLE SHEDS', 33.30934, -112.50633], ['NORTH LAKE PLEASANT', 33.91138, -112.28439], ['NORTH PROVING GROUNDS', 33.79377, -112.49906],
  ['NORTHERN BALD SPOT', 35.00874, -112.35203], ['OLD DRAKE VOR', 34.90114, -112.41768], ['ORME SCHOOL AIRPORT', 34.42837, -112.06269],
  ['OUTLET MALLS', 33.87369, -112.14998], ['PAINTED ROCK DAM', 33.07412, -113.01332], ['PALOVERDE POWER PLANT', 33.38727, -112.86521],
  ['PERKINSVILLE VALLEY', 34.90229, -112.19548], ['PICACHO PEAK', 32.63554, -111.40279], ['PICACHO RESERVOIR', 32.85220, -111.48130],
  ['PINNACLE PEAK', 33.72762, -111.86457], ['PIPELINE', 33.87120, -112.19775], ['POINT LIMA', 33.40941, -111.61268],
  ['POINT WHISKEY', 33.38878, -111.50868], ['POINT X-RAY', 33.17059, -112.28435], ['PRESCOTT RESORT', 34.55077, -112.44692],
  ['PRISON', 33.83364, -112.16835], ['PUMPING STATION NW', 33.66097, -112.68983], ['PUMPING STATION TUCSON', 32.36123, -111.37408],
  ['QUINTERO GOLF COURSE', 33.84689, -112.41863], ['RADOME', 33.98099, -111.79794], ['RAILROAD TRACKS', 33.24237, -112.99604],
  ['RAINBOW GREENFIELDS', 33.22655, -112.43431], ['RAINBOW RANCHO', 33.22160, -112.30729], ['RENAISSANCE FEST', 33.32107, -111.43121],
  ['RINCON PEAK', 32.11961, -110.51706], ['RIO VERDE COMMUNITY', 33.72405, -111.67568], ['RITTENHOUSE', 33.25743, -111.51707],
  ['SACATON PEAK', 33.00258, -111.67530], ['SACATON TOWN', 33.07237, -111.74352], ['SAGUARO LAKE', 33.57001, -111.51942],
  ['SAHUARITA', 31.95716, -110.95589], ['SANTAN PEAK', 33.17311, -111.71160], ['SAWTOOTH STREET PATTERNS', 32.55572, -111.71899],
  ['SEMI-CIRCLE RANCH', 34.52990, -112.98283], ['SERENE PRIVATE', 32.99485, -112.27231], ['SHOOTING RANGE', 33.80435, -112.15209],
  ['SILVER BELL MINE', 32.40313, -111.52531], ['SKULL VALLEY', 34.50397, -112.68487], ['SOUTH CATTLE SHEDS', 33.27163, -112.49083],
  ['SOUTH CROP CIRCLES', 32.90398, -112.05790], ['SOUTH PROVING GROUNDS', 33.69617, -112.49731], ['SOUTH TEST TRACK', 32.94262, -111.98237],
  ['SOUTHERN BALD SPOT', 34.94875, -112.38453], ['ST MATTHEWS', 34.76804, -112.25257], ['STREET PATTERN', 33.80197, -111.77834],
  ['SUBSTATION', 33.70869, -112.32255], ['SUPER MALL', 33.38978, -111.68949], ['SUPERIOR TOWN', 33.29581, -111.09831],
  ['SYCAMORE CREEK', 33.65909, -111.61132], ['TABLE MOUNTAIN', 34.71493, -112.53362], ['TABLE TOP', 32.75194, -112.12456],
  ['THE GAP SE', 33.17310, -111.67104], ['THUMB BUTTE', 34.54680, -112.51919], ['TONOPAH PRIVATE', 33.53335, -112.96029],
  ['TRI TRAILS', 32.97455, -111.12539], ['TWIN FIELDS', 34.62151, -112.64805], ['TWIN LAKES', 33.35015, -112.43623],
  ['WAGON WHEEL', 33.41196, -111.72342], ['WATER SKI LAKE', 33.17207, -111.47364], ['WATERMANS WASH', 33.17645, -112.36685],
  ['WITCHS HAT', 33.11536, -111.64858], ['WOOLSEY PEAK', 33.16772, -112.88484],
];
points.forEach((p) => { const d = DEFAULT_POS[p.name]; if (d) { p.lat = d[0]; p.lon = d[1]; } });
LANDMARKS.forEach((l) => points.push({ name: l[0], desc: 'AFTW landmark (AFTW map Nov 2025)', lat: l[1], lon: l[2], aftw: true }));

// ---------- helpers
const forAirport = (icao, kind, procs) => (Array.isArray(procs) ? procs : procedures).filter((p) => p && p.airport === icao && (!kind || p.kind === kind));

const findTransition = (proc, tid) => {
  if (!proc || !Array.isArray(proc.transitions) || tid === null || tid === undefined || tid === '') return null;
  const s = String(tid);
  return proc.transitions.find((t) => t && (t.id === s || t.id === proc.id + '.' + s)) || null;
};

const expand = (proc, transitionId) => {
  if (!proc) return [];
  const gate = proc.gate || proc.point;
  const g = gate ? [{ name: gate, alt: proc.alt === undefined ? null : proc.alt, role: 'gate' }] : [];
  const t = findTransition(proc, transitionId);
  const tp = t ? (t.points || []).filter((p) => p && p.name).map((p) => ({ name: p.name, alt: p.alt === undefined ? null : p.alt, role: 'trans' })) : [];
  return proc.kind === 'arr' ? tp.concat(g) : g.concat(tp);
};

const pointNames = (procs) => {
  const s = new Set();
  (Array.isArray(procs) ? procs : []).forEach((p) => {
    if (!p) return;
    const g = p.gate || p.point;
    if (g) s.add(g);
    (p.transitions || []).forEach((t) => (t && t.points || []).forEach((pt) => { if (pt && pt.name) s.add(pt.name); }));
  });
  return Array.from(s).sort();
};

// byName: {name: point} or a function name -> point (the OFP page also resolves LAT airport idents, e.g. '1AZ0', to the airport)
const lookup = (byName, name) => (typeof byName === 'function' ? byName(name) : byName[name] || byName[String(name).toUpperCase()]);
const usable = function (proc, tr, byName) {
  if (arguments.length < 3) { byName = tr; tr = null; }
  if (!proc || !byName) return false;
  const pts = expand(proc, tr);
  return pts.length > 0 && pts.every((p) => { const w = lookup(byName, p.name); return !!w && Number.isFinite(w.lat) && Number.isFinite(w.lon); });
};

const merge = (defaults, dbRows) => {
  const rows = Array.isArray(dbRows) ? dbRows : [];
  const over = new Map(), hidden = new Set();
  rows.forEach((r) => {
    if (!isObj(r) || typeof r.id !== 'string' || !r.id) return;
    if (r.hidden === true) { hidden.add(r.id); over.delete(r.id); return; }
    if (!isObj(r.data)) return;
    over.set(r.id, normalize(Object.assign({}, r.data, { id: r.id })));
  });
  const out = [], seen = new Set();
  (Array.isArray(defaults) ? defaults : []).forEach((d) => {
    if (!d || typeof d.id !== 'string') return;
    seen.add(d.id);
    if (hidden.has(d.id)) return;
    out.push(over.has(d.id) ? over.get(d.id) : normalize(d));
  });
  const extra = Array.from(over.values()).filter((p) => !seen.has(p.id) && !hidden.has(p.id));
  extra.sort((a, b) => a.airport.localeCompare(b.airport) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return out.concat(extra);
};

const ATO = {
  procedures: procedures, points: points, forAirport: forAirport, usable: usable,
  merge: merge, normalize: normalize, expand: expand, pointNames: pointNames,
};
if (typeof module !== 'undefined' && module.exports) module.exports = ATO; else root.ATO = ATO;
})(this);
