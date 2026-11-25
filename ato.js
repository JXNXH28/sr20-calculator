// LAT ATO departure/arrival procedures (FF Plate Binder, Jan 23 / Oct 26 / Sep 2025 plates) with the
// B02 time and distance table (Sep 26 briefing, p42 "Exit and Entry Points at GYR").
// min/nm: time (whole min) and distance (NM) from the airport to the exit point (dep) or from the entry point
// to the airport (arr). null = B02 gives none, the leg then falls back to the wind triangle.
// extraMin: minutes B02 adds on top (+10 for a full-stop arrival into KGYR for pattern entry and landing).
// extraMinDest: extra minutes only when the flight ends at that airport (Power Plant DEP into KGEU: +10).
// alt: altitude (ft MSL) at the point per the plate, null if the plate gives none.
// Points have no coordinates here: an admin places them (waypoints table, owner null), see ATO.usable.
// Verify against the current plates and B02.
(function (root) {
'use strict';
const BIN = 'FF Plate Binder p';
const mk = (id, airport, kind, name, point, min, nm, alt, o, plate, notes) => Object.assign({
  id: id, airport: airport, kind: kind, name: name, point: point, min: min, nm: nm, alt: alt,
  dualOnly: false, extraMin: 0, plate: BIN + plate, notes: notes || '',
}, o || {});
const FS = { extraMin: 10 }; // B02: all full-stop arrivals into KGYR, +10 min for pattern entry and landing

const procedures = [
  // ---- KGYR departures (B02 exit points)
  mk('GYR-DEP-GILACROSSING', 'KGYR', 'dep', 'Gila Crossing DEP', 'PIR', 5, 5, 2700, null, 4,
    'RWY 21: 2000 or Gila River, then 2700 left downwind; RWY 3: 2000/Litchfield Rd then 2700. Fly ~130 at 2700 until 1 NM SW of Gila Crossing. Transitions: Chandler (North Test Track, at/below 5500), Gateway (North Test Track, inbound below 5500 descending to 3000). Avoid Class B.'),
  mk('GYR-DEP-BUCKEYE', 'KGYR', 'dep', 'Buckeye DEP', 'LIBERTY BRIDGE', 4, 7, 2000, null, 1,
    'Track the Gila River at 2000 until south of KBXK. Transitions: Buckeye (2000, 4 mile 45), Western (Arlington >=3000, I-10 >=5000), Northern (Arlington >=3000, I-10 >=5000, contact Luke on 125.45, 5500), Southwest (Arlington >=3000).'),
  mk('GYR-DEP-TWINLAKES', 'KGYR', 'dep', 'Twin Lakes DEP', 'LIBERTY BRIDGE', 5, 7, 3500, null, 10,
    'Climb to 3500 at Liberty Bridge. Bishop transition (PPR), Tire Farm transition (4500), Southwest transition is DUAL ONLY. Avoid housing around Twin Lakes.'),
  mk('GYR-DEP-POWERPLANT', 'KGYR', 'dep', 'Power Plant DEP', 'THE STACK', 5, 6, 2700, { dualOnly: true, extraMinDest: { KGEU: 10 } }, 8,
    'DUAL ONLY. Not authorized for solo student flights. B02: add 10 min if used for an arrival into KGEU. Call KGEU tower before the stack; fly 013 at 2700 to the Power Plant, then contact Luke on 118.15.'),
  // ---- KGYR arrivals (B02 entry points, +10 min for a full stop)
  mk('GYR-ARR-LUKEAUX6', 'KGYR', 'arr', 'Luke Aux 6 ARR', 'LUKE AUX 6', 3, 7, 2000, FS, 9,
    'Arrive 1/2 NM south of Luke Aux 6 at 2000, then as directed by tower. Transitions: Bishop (2500 then 2000), Buckeye RWY 17/35, Northwest (solo, 6000 then 3500/2500/2000), Southwest (2500 then 2000). Avoid Palo Verde Power Plant by 3 NM; do not cross I-10.'),
  mk('GYR-ARR-GAP', 'KGYR', 'arr', 'Gap ARR', 'THE GAP', 2, 5, 2500, FS, 2,
    'Arrive from south of the Gap at 2500, descend and maintain 2000 from the Gap. Call tower no closer than 4 NM south of the Gap. South transition is DUAL ONLY; Bishop (PPR) and Tire Farm (3500) transitions.'),
  mk('GYR-ARR-GILACROSSING', 'KGYR', 'arr', 'Gila Crossing ARR', 'GILA CROSSING', 6, 14, 2000, FS, 3,
    'Arrive 1 NM NE of Gila Crossing at 2000. Call tower abeam Gila Crossing. Left DW RWY 21 / right base RWY 3: heading 300; right DW RWY 3: 320 to Lower Buckeye Rd; left base RWY 21: heading 305 to the Cattle Sheds.'),
  mk('GYR-ARR-POWERPLANT', 'KGYR', 'arr', 'Power Plant ARR', 'THE STACK', 3, 6, 2600, Object.assign({ dualOnly: true }, FS), 7,
    'DUAL ONLY. Not authorized for solo student flights. 2600 passing 1 NM west of the Glendale Power Plant / stack, heading 168 to Lower Buckeye Rd and descend to 2000. Contact KGEU tower prior to Class D transition.'),
  // ---- KGEU (B02 gives no time or distance)
  mk('GEU-ARR-GLENDALE', 'KGEU', 'arr', 'Glendale ARR (solo route)', 'GILA CROSSING', null, null, 2700, null, 5,
    'Solos fly the Gila Crossing DEP until 1 NM SW of Gila Crossing, then heading 325 at 2100 to 1 NM east of the Stack at Tolleson. Contact KGEU tower prior to Tolleson.'),
  mk('GEU-DEP-GLENDALE', 'KGEU', 'dep', 'Glendale DEP (solo route)', 'GILA CROSSING', null, null, 2500, null, 6,
    'Fly 1 NM west of the Stack, heading 145 to abeam Gila Crossing, climb and maintain 2500. Southeast departure: climb on course referencing airspace. Contact KGYR tower south of I-10.'),
  mk('GEU-ARR-POWERPLANT', 'KGEU', 'arr', 'Glendale Transition (Power Plant DEP)', 'THE STACK', null, null, 2700, { dualOnly: true }, 8,
    'DUAL ONLY. Prior to the I-10/101 stack contact KGEU tower and comply with directions. B02 adds 10 min to the Power Plant DEP for an arrival into KGEU.'),
  mk('GEU-DEP-POWERPLANT', 'KGEU', 'dep', 'Glendale Airport Transition (Power Plant ARR)', 'THE STACK', null, null, 2600, { dualOnly: true }, 7,
    'DUAL ONLY. Depart direct to 1 NM west of the I-10/101 stack at 2600, then heading 168 to Lower Buckeye Rd.'),
  // ---- E63 (B02 gives no time or distance; arrival points are not required at off-site airports)
  mk('E63-ARR-NORTH22', 'E63', 'arr', 'E63 Pattern Entry RWY 22 (North)', 'E63 NORTH RWY22', null, null, 2600, null, 11,
    'Cross midfield at 2600, then descend to 1600 (pattern). Remain north of I-8 at all times. Contact Gila Bend AF Aux tower ~15 NM out.'),
  mk('E63-ARR-EAST22', 'E63', 'arr', 'E63 Pattern Entry RWY 22 (East)', 'E63 EAST RWY22', null, null, 1600, null, 11,
    'Aim for the NW corner of Baby Camelback Mountain, descend to 1600. Remain north of I-8 at all times.'),
  // ---- KBXK / 1AZ0 Pipeline Transition (PPR for 1AZ0)
  mk('BXK-DEP-PIPELINE', 'KBXK', 'dep', 'Pipeline Transition (to 1AZ0)', 'VOLCANO MTN', null, null, 3000, null, 12,
    'PPR required for 1AZ0. Maintain 3000 direct the black volcano-like mountain south of the Gila River, heading 120 2 NM north of the pipeline, 3500 near 1AZ0.'),
  mk('BXK-ARR-PIPELINE', 'KBXK', 'arr', 'Pipeline Transition (from 1AZ0)', 'THE DAM', null, null, 2000, null, 13,
    'PPR for 1AZ0. Abeam the Dam on the Gila River turn north heading 350 at 2000 to the 45 degree entry for KBXK.'),
  mk('1AZ0-ARR-PIPELINE', '1AZ0', 'arr', 'Pipeline Transition (from KBXK)', 'WATERMAN WASH', null, null, 3500, null, 12,
    'PPR REQUIRED. Crossing Waterman Wash proceed direct to 1AZ0, climb and maintain 3500, cross midfield. Operating at or near 1AZ0 during CPS ops is PROHIBITED.'),
  mk('1AZ0-DEP-PIPELINE', '1AZ0', 'dep', 'Pipeline Transition (to KBXK)', 'TANGO', null, null, 3000, null, 13,
    'PPR REQUIRED. Climb to 3000, direct TANGO, then 3500 over Waterman Wash, 2 NM south of the pipeline. Avoid the Luke Corridor (GBN R-346 to R-360, 3500 and above).'),
];

const points = [
  { name: 'PIR', desc: 'Phoenix International Raceway (VPPIR), exit point of the Gila Crossing DEP', plate: BIN + '4' },
  { name: 'LIBERTY BRIDGE', desc: 'Bridge over the Gila River, exit point of the Buckeye and Twin Lakes DEP', plate: BIN + '1, 10' },
  { name: 'THE STACK', desc: 'I-10 / Loop 101 interchange at Tolleson, Power Plant DEP/ARR point', plate: BIN + '7, 8' },
  { name: 'LUKE AUX 6', desc: 'Luke Aux 6 auxiliary field, entry point of the Luke Aux 6 ARR', plate: BIN + '9' },
  { name: 'THE GAP', desc: 'Gap in the Estrella foothills south of KGYR, entry point of the Gap ARR', plate: BIN + '2' },
  { name: 'GILA CROSSING', desc: 'Gila Crossing, entry point of the Gila Crossing ARR; KGEU solo route point', plate: BIN + '3, 5, 6' },
  { name: 'E63 NORTH RWY22', desc: 'E63 pattern entry RWY 22, north transition (midfield crossing)', plate: BIN + '11' },
  { name: 'E63 EAST RWY22', desc: 'E63 pattern entry RWY 22, east transition (Baby Camelback Mountain NW corner)', plate: BIN + '11' },
  { name: 'VOLCANO MTN', desc: 'Black volcano-like mountain south of the Gila River (KBXK Pipeline departure)', plate: BIN + '12' },
  { name: 'THE DAM', desc: 'Dam on the Gila River (Pipeline Transition, KBXK arrival side)', plate: BIN + '13' },
  { name: 'WATERMAN WASH', desc: 'Waterman Wash crossing (Pipeline Transition, 1AZ0 arrival side)', plate: BIN + '12' },
  { name: 'TANGO', desc: 'East side of the Maricopa Mountains, west of Waterman Wash, 2 NM south of the pipeline', plate: BIN + '13' },
];

const forAirport = (icao, kind) => procedures.filter((p) => p.airport === icao && (!kind || p.kind === kind));
const usable = (proc, wptsByName) => {
  const w = proc && wptsByName && wptsByName[proc.point];
  return !!w && Number.isFinite(w.lat) && Number.isFinite(w.lon);
};

const ATO = { procedures: procedures, points: points, forAirport: forAirport, usable: usable };
if (typeof module !== 'undefined' && module.exports) module.exports = ATO; else root.ATO = ATO;
})(this);
