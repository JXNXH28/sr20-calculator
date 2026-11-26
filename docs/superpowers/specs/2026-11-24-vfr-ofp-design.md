# VFR OFP builder — design

## Context
Students at LAT US (Cirrus SR20, KGYR) must turn in an Operational Flight Plan (OFP, the "European Flight Academy" nav-log form) for every cross country. Today it's planned by hand (B02 briefing) or in an Excel sheet with known quirks. The calculator site already does T/O sheets, but leg time and trip fuel there are typed in by hand. The goal is a new OFP page: the student clicks waypoints on the FAA TAC/sectional, the app does every calculation by the B02 rules plus safety checks, prints the OFP on the ATO form, exports the route to ForeFlight, and hands time and fuel to the T/O sheets.

**Decided with the user**
- Main job: **replace hand planning**. The app plans, the student reviews and prints. Every number can be tapped to show how it was calculated.
- Routing: **the student picks the waypoints; the app checks** and never picks for them (no automatic routing).
- Rules: **B02 hand method** (not the Excel formulas). The ALTN rows stay blank unless an alternate is added.
- Paper chart: **on-screen only**. Chart-prep marks are drawn on the map, with no printed chart strip.
- Build: **its own page** (`ofp.html`) next to the T/O sheets.
- Scope: **one release that includes the safety layer** (automatic MSA, airspace, glide range, emergency fields).
- Price: **3 tokens per flight**, charged the first time an OFP is finalised. Later edits, weather refreshes and re-prints of the same flight are free.
- **One OFP per flight**: off block to on block, with one takeoff fuel. Touch-and-goes, taxi-backs and airwork are inside it. A shutdown (for example a full stop and refuel at E63) ends the flight, and the next leg is a new OFP, started with a "Return flight" or "Next flight" button.

**Source documents** (in `~/Downloads`): B02 briefing `Doc_B0_2-SEP-26.pdf.pdf` (worked OFP example pp60–85, rules pp35–91, exit and entry table p42), `Doc_IFR-OFP-Guidance.pdf.pdf`, blank form `Doc_Excel-Nav-Log---Simple.pdf.pdf`, `Excel Nav Log - Formula.xlsx`, `FF Plate Binder.pdf` (13 plates; landmarks only, no coordinates), the airport list (already in `airports.js`), and the SR20 POH (cruise table on PDF pp180–181, glide on about p112).

**Non-goals:** IFR OFP, automatic route suggestion, a printed chart strip, filing a flight plan from the site, the in-flight columns (ATO, Act. Fuel, actual times stay blank for pen), mass and balance on the OFP (that stays in the T/O sheet), a ForeFlight content pack (later).
**Anti-goals:** a printout an instructor would reject (numbers that differ from the B02 method, or a layout that differs from the form); silently trusting automatic MSA or airspace without a "verify on chart" note.

## Approaches considered
- **A. Own OFP page — chosen.** A map-first layout. It reuses auth, `airports.js`, the weather relay, `perf.js` and the pdf-lib drawing approach, and hands legs to the T/O flow.
- B. A fourth step inside `app.js`: rejected. `app.js` is about 1900 lines with a flat form state, and a full-screen map editor doesn't fit its step cards.
- C. Framework rewrite: rejected. It adds a build step and rewrites working code first.

## Verified data sources (all free, browser-reachable, no keys)
| Need | Source |
|---|---|
| TAC / sectional tiles | `https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/{VFR_Terminal\|VFR_Sectional}/MapServer/tile/{z}/{y}/{x}` (FAA, current cycle; tested 200 for Phoenix; TAC z10–12, sectional ≤ z12) |
| Airspace | ADDS `Class_Airspace`, `Special_Use_Airspace` FeatureServers (same base as `ADDS` in `autofill.js:42`) |
| Airports, navaids, fixes | ADDS `US_Airport`, `NAVAIDSystem`, `DesignatedPoints`, `Frequencies` |
| Obstacles | ADDS `Digital_Obstacle_File` (fields `Lat_DD`, `Long_DD`, `AGL`, `AMSL`, `Type_Code`) |
| Terrain | AWS Terrarium tiles `elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png` (CORS `*`) |
| Winds and temperature aloft | Open-Meteo pressure levels (GFS/HRRR), interpolated to the leg altitude; true, converted to magnetic. (The FAA FB winds-aloft text product was retired with the NAM model, SCN26-47, so it is not used.) |
| Magnetic variation | Vendored WMM2025 model (`vendor/wmm.js`, small, MIT): variation at any point and date |

## Design

### Files
- **`ofp.html`**: a new page. The map takes the full height. A side panel holds the flight header, the leg table, checks and actions. On a phone the panel becomes a bottom sheet. Scripts load in the same order as index.html (config, auth, vendor, airports, perf, wx), then `vendor/leaflet`, `vendor/wmm.js`, `nav.js`, `ofpdata.js`, `ofpform.js`, `ofp.js`. Middleware already protects every page except login.
- **`nav.js`**: pure maths, UMD like `perf.js` and testable in node:
  - great-circle distance and bearing, and points along a course
  - wind triangle
  - B02 time and fuel rules
  - TOC/TOD
  - MSA from samples
  - semicircular-altitude rule
  - glide reach
  - all the checks
- **`ofpdata.js`**: network and caching only. ADDS queries by bounding box (airspace, airports, navaids, DOF), terrain-tile decoding, Open-Meteo winds aloft. Cached in localStorage/IndexedDB by 56-day cycle or 30 days, like `autofill.js`.
- **`ato.js`**: the fixed list of ATO procedures from B02 p42 and the plate binder. Each entry has: airport, dep/arr, name (e.g. "Buckeye DEP"), the transition point name(s), fixed minutes and NM (e.g. Liberty Bridge via Buckeye DEP 0:04/7 NM, via Twin Lakes DEP 0:05/7 NM; The Stack is 0:05/6 outbound and 0:03/6 inbound), plate altitude, solo/dual-only, and extra minutes (+10 for a GYR full-stop arrival, +10 for Power Plant DEP into KGEU). Times belong to the procedure, not the point, because the same point has different times by direction and route. Points are referenced by name and get coordinates from the `waypoints` table.
- **`ofpform.js`**: base64 of the blank OFP form (`Doc_Excel-Nav-Log---Simple.pdf`), the same pattern as `form1002.js`.
- **`ofp.js`**: UI state, map layers, the leg table, print and export.
- **`perf.js`**: add the POH cruise table (2600 lb, PA 2000–14000 in 2000 ft steps × RPM/MAP rows × ISA−30/ISA/ISA+30, giving %/KTAS/GPH) and `cruise({pa, isaDev, pwr=75})`. It interpolates to the target power within each altitude block, then across ISA deviation and altitude, as B02 p64–65 does (example: 6500 ft gives about 74%, 151 KTAS, 12.7 GPH). Uses only POH rows, not the Excel's added "75%" rows.
- **`db/schema.sql`**: changes listed under Data.
- **`app.js`**: takes the OFP handover. One OFP is one T/O-flow leg: dep → dest, flight time (total EET), trip fuel, takeoff fuel. It's passed via the localStorage key `ofp.handoff` and opened with `index.html?from=ofp`. If the T/O flow already has a route, the student chooses to replace it or append this leg. Touch-and-goes and taxi-backs don't become T/O stops.
- **`api/aw/[ep].js`** and `server.js`: allow `windtemp`.
- **`admin.js`**: OFPs in the overview and log, and ATO waypoint placement (see below).
- **`test.js`**: new `nav` and `cruise` sections.
- **`README.md`**: describe the new page.

### Map and route editing
- Leaflet base layers: TAC by default, sectional as a toggle and automatically outside TAC coverage. Overlays: airspace, ATO waypoints, personal waypoints, airports, glide band, chart-prep marks.
- **Adding points:**
  - Click the map to add a point. It snaps to a nearby library point (ATO, personal, airport, navaid) within a few pixels, or becomes a coordinate point.
  - Search box for idents and names.
  - Drag a point to move it. Drag a leg's midpoint to insert a point.
  - Right-click or long-press a point to delete it or save it as a personal waypoint with a name.
- **Live overlay** on the leg being drawn and on each leg: MC, distance, and minutes at the leg's groundspeed.
- **Waypoint library:**
  - The `waypoints` table holds shared ATO points (`owner null`, admin-edited) and personal points (`owner = uid`).
  - The names of the points that `ato.js` procedures refer to are listed **without coordinates**. The admin places each one on the map in an edit mode on `ofp.html` (admins only), and only placed points are shown.
- Departure and arrival: the first and last points are airports from `airports.js` (approved list).
  - When leaving GYR, the student picks a departure procedure. Its exit point becomes the first waypoint, and the first leg uses the procedure's fixed time and distance instead of the wind-triangle time.
  - Arrival procedures into GYR work the same way, plus +10 min for a full-stop arrival (B02 p42).

### Calculations (B02 rules, all in `nav.js`)
- **Magnetic course:** true course from great-circle at the leg midpoint, plus WMM variation at the leg midpoint, rounded to whole degrees.
- **Winds aloft:**
  - Open-Meteo at the leg midpoint and planned time, interpolated to the leg altitude.
  - Converted to magnetic.
  - Editable per flight (a single "Cruise MAG W/V" like the form header) or per leg.
  - Shown with source and age, like the pre-flight check panel.
- **Performance:**
  - The temperature at cruise altitude gives ISA deviation.
  - `Perf.cruise` gives TAS and FF for each altitude used.
  - The Notes box lists TAS/FF per altitude, as in the B02 p66 example.
- **Wind triangle:** WCA = asin(crosswind/TAS) in whole degrees, signed so that heading = MC + WCA. GS is rounded to whole knots.
- **EET:** ceil(dist/GS × 60), plus climb minutes, plus approach or remark minutes. Fixed-time ATO legs use their fixed time.
- **Climb add (B02 p71–72):**
  - Climb above the previous altitude, or above 1000 ft AGL on the first leg, rounded to the nearest 1000 ft.
  - Adds 1 min per 2000 ft (rounded up) and 0.5 gal per 2000 ft (pro rata, to 0.1).
  - Descents add nothing.
- **Approach and remarks (B02 p80–81):** each arrival picks its remark from:
  - full stop
  - touch-and-go ×n
  - full-stop taxi-back ×n
  - airwork X min
  The extra minutes are +10 first arrival, +5 per extra pattern, +10 per extra full-stop taxi-back, and airwork minutes. They are charged at cruise FF, plus 0.5 gal for the first full-stop taxi-back.
- **Fuel:**
  - Leg fuel = EET/60 × FF + climb fuel, to 0.1.
  - Pl. Fuel = takeoff fuel − cumulative leg fuel.
  - Min. Fuel at the destination = reserve (30 min day, 45 min night, at cruise FF). Each row above adds the next leg's fuel, working upward.
  - Totals: EET and trip fuel.
- **Times:** PTO = T/O time + cumulative EET. Off Block and On Block are header fields. On Block defaults to Off Block + the block time entered.
- **TOC/TOD (B02 p90–91):**
  - TOC distance = (cruise − 1000 ft AGL) at 105 kt and 500 fpm.
  - TOD = (alt to lose)/1000 × 3 + 5 NM from the destination, with descent rate GS × 5.
  - Both are drawn on the map.
- **Every computed cell** keeps a short "how" string, shown when tapped. Example: "8 NM / 147 kt = 3.3 → :04".

### Safety layer
- **Automatic MSA per leg (B02 p43/p88):**
  - Highest of terrain (Terrarium samples in a 5 NM corridor) and DOF obstacle AMSL within 5 NM of the leg.
  - Round up to the next 500 ft, then add 1000 ft. Example: 4512 → 5000 → 6000.
  - Shows where the highest point is (a map marker) and is labelled "verify on chart". The student can override it.
  - The MSA circle values on plates are not used.
- **Altitude recommender per leg:**
  - Candidates are semicircular altitudes (east 0–179° odd thousands +500, west even +500; the rule applies above 3000 ft AGL).
  - For each candidate, a table shows: ≥ MSA, airspace conflicts, TAS/FF, GS with winds at that level, and time and fuel.
  - The default pick is the lowest conflict-free altitude ≥ MSA. The student chooses.
  - The first/exit altitude and the destination TPA come from the plate or the airport (e.g. 2700, TPA 1600) and can be edited.
- **Airspace:**
  - Each leg's altitude profile (climb and descent included) is checked against Class B/C/D floors and ceilings and against special-use airspace (restricted, MOA, alert, warning).
  - Each conflict is listed with name, floor/ceiling and the leg position.
  - Class B shelves show whether the leg passes under the shelf or into it.
- **Glide band and emergency fields:**
  - Reach = (altitude − field elevation) / 6076 × 9 NM (POH about 9:1, best glide 92 KIAS at 2600 lb), with no wind and a safety factor of 0.8 (my call).
  - Candidate fields are ADDS airports (public and private) plus the LAT list.
  - Each leg shows its reachable fields, which are circled on the map, and the stretches where none is reachable are flagged.
  - Emergency fields are listed per leg in the OFP Notes box.
- **Chart-prep marks** (on screen, B02 p44):
  - checkpoints circled
  - 10 NM ticks counted back from each checkpoint
  - 2-min ticks on the opposite side
  - leg arrows "n–MC–EET–MSA/100"
  - highest elevation marked
  - TOC/TOD
  - emergency fields circled
- **Checks (warn, never block):**
  - a leg over 30 NM
  - the altitude breaks the semicircular rule
  - below MSA
  - an airspace conflict
  - a gap in glide reach
  - an airport not approved for solo, dual, day or night (from the `airports.js` flags and the flight's solo/dual and night inputs)
  - high-elevation limits (`lim`)
  - not using an ATO exit or entry point at GYR
  - takeoff fuel > 56 USG usable
  - Pl. Fuel at the destination < Min. Fuel
  - more than 18 legs (the form’s capacity)

### Output
- **OFP PDF:** pdf-lib draws onto the blank form at measured cell coordinates, the same approach as `drawSheet` (`app.js:416`).
  - The header is filled.
  - Legs 1–11 go in the left ladder (leg 1 is the departure-procedure leg with the pre-printed XXX cells) and 12–18 in the right.
  - Totals are filled.
  - The Notes box gets TAS/FF per altitude and the emergency fields.
  - The in-flight cells are left empty.
  - Preview, print and download work the same way as the T/O sheet (`act()` at `app.js:1504`).
- **ForeFlight:** downloads a `.fpl` (Garmin FlightPlan v1 XML). Airports and navaids are typed by ident; other points are USER WAYPOINTs with lat/lon and the library name (max 6 characters, uppercase). It opens in ForeFlight via Files/AirDrop. A route-string copy button gives idents plus lat/lon.
- **To T/O sheets:** a button described under Files.

### Data, tokens, saving
All schema changes are additive (expand only). The existing T/O path (`calculations`, `calculate`) is untouched.
- **New table `ofps`:** `id, user_id, flight_date, dep, dest, route text, reg, inputs jsonb, created_at, updated_at`.
  - RLS select: own rows, and admins see all.
  - Index `(user_id, created_at desc)`.
- **`token_ledger`:**
  - New nullable column `ofp_id bigint references ofps on delete set null`.
  - The `reason` check is widened to include `'ofp'` (drop and re-add the constraint, idempotently).
- **New RPC `finalize_ofp(p_id bigint, p_inputs jsonb, p_flight_date date, p_dep text, p_dest text, p_route text, p_reg text)`:**
  - Size check like `calculate`, and locks the profile.
  - If `p_id` is the caller's OFP **and** `flight_date`, `dep` and `dest` are unchanged, it updates `inputs`/`route`/`reg`/`updated_at` **free**. That makes it the same flight.
  - Otherwise it checks disabled and `tokens >= 3` (**price is a server constant**), inserts, deducts 3, and writes a ledger row (`reason 'ofp'`, `ofp_id`).
  - Returns `{id, balance, charged}`.
- **New table `waypoints`:** `id, owner uuid null, name, ident, lat, lon, notes, created_at, updated_at`. `owner null` means a shared ATO point.
  - RLS select: `owner is null or owner = auth.uid()`.
  - Writes only through RPCs:
    - `upsert_waypoint` and `delete_waypoint` for personal points, owner only.
    - `admin_upsert_waypoint` for shared points, `is_admin()`.
  - Lat/lon range checks and name length limits.
- **Drafts** autosave to localStorage, along with the OFP id once finalised. **Finalise** is needed before printing or exporting.
- **OFP history list** (`ofps`): open, duplicate (as a new flight), and return flight (reversed route and procedures, as a new flight).
- **Rollback:** drop the RPC and the new tables, and revert the reason constraint. T/O data is unaffected.

### What's left to the builder
- Exact cell coordinates on the form.
- The Leaflet version.
- The WMM implementation (any small MIT WMM2025).
- Terrain zoom level and sampling step (aim for about 0.5 NM).
- Caching details.
- Mobile layout specifics.
- How the 18-leg capacity is split when there are alternates.

## Verification
- `node test.js` with new cases taken from B02's worked examples:
  - 8 NM / 147 kt gives :04 and 0.9 gal at 12.9 GPH.
  - Climb 2700 → 5500 gives +2 min / ≈0.8 gal.
  - 3 touch-and-goes to a full stop give :25 and 5.3 gal at 12.7.
  - The Min. Fuel ladder 6.4 → 13.2 → 14.1 → 22.4 → 24.7 → 25.6.
  - The planned-fuel ladder from 54.5 to 34.2.
  - TOD for 6500 → TPA 1600 gives 19.7 NM.
  - MSA 4512 gives 6000.
  - WCA for MC 309 with 250/10 gives −4, and MC 124 gives +3.
  - Cruise at 6500 ISA gives about 74% / 151 / 12.7.
  - Great-circle distance and bearing against known pairs.
  - WMM variation at KGYR about 10–11°E.
- Run `node server.js` and preview `/ofp.html` in the built-in browser, then plan:
  - KGYR → Liberty Bridge → … → E63 → KGYR
  - Check against B02's example OFP numbers.
  - Check that the airspace and MSA warnings appear (e.g. a leg into the PHX Class B).
  - Print the PDF and compare it against the blank form.
  - Import the `.fpl` into ForeFlight.
  - Send to T/O sheets and confirm the legs fill in.
- Apply the schema change on Supabase, then check:
  - The first finalise charges 3 tokens.
  - Editing and refreshing winds, then finalising the same flight again, is free.
  - Changing the date or the destination charges 3 again.
  - Fewer than 3 tokens is refused.
  - T/O still charges 1.

## After approval: execution
- **Orchestration and planning on Opus (this session):**
  - Write this design to `docs/superpowers/specs/2026-11-24-vfr-ofp-design.md`.
  - Write the step-by-step implementation plan with superpowers:writing-plans.
  - Hand out tasks, review each result against the spec and B02, and run the verification.
- **Coding on Sonnet subagents:** each task goes to an Agent with `model: "sonnet"`. Each gets a self-contained brief: the files it owns, the spec sections, the acceptance tests and the B02 pages.
- **Task order and dependencies:**
  1. Pure core, independent and run in parallel:
     - (a) `nav.js` and `vendor/wmm.js`, with tests from the B02 worked examples
     - (b) cruise table and `Perf.cruise` in `perf.js`, with tests
     - (c) `ato.js` procedures from B02 p42 and the plate binder
     - (d) `db/schema.sql` additions (`ofps`, `waypoints`, ledger column and constraint, RPCs)
  2. Data and infra, in parallel:
     - (e) `ofpdata.js`: ADDS, DOF, terrain, winds
     - (f) relay `windtemp` in `api/aw/[ep].js` and `server.js`
     - (g) `ofpform.js` and the PDF drawing with measured cell coordinates
  3. `ofp.html` and `ofp.js`: map, route editing, leg table, safety layer, checks, finalise, history, `.fpl` export.
  4. Integration:
     - `app.js` handover, plus a link to the OFP page from the main app
     - admin OFP view and ATO waypoint placement
     - README
- After each task: Opus reviews the diff and runs `node test.js`.
- At the end: browser verification of the full flow on `node server.js`.
- Commits go on a new branch `feature/vfr-ofp` off the current branch, one commit per task. Nothing is pushed until the user asks.
- The schema SQL is written but **not applied** to Supabase. The user runs it.
