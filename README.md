# SR20 T/O data sheet & load sheet calculator

Fills LAT US form 1002 (Single-Engine Land T/O Data Sheet + SR20 Load Sheet) from the
LAT PA Training Handbook SR20 Rev 06 tables (linear interpolation). Everything runs in the browser;
the filled PDF is generated client-side onto the original form.

**Training aid only. Verify all values against the THB, the POH and the aircraft weight report.**

## Use
The page guides you top to bottom; the banner at the top always names the next missing thing.
1. **Flight**: route (for example `KGYR → KBXK → KGYR`, stops autocomplete from the LAT approved airport list), date,
   departure time, registration (autocompletes from the fleet table, which fills BEM and CG) and flight number.
2. **People & fuel**: seat weights and take-off fuel. Baggage, trim, name and BEM/CG sit under "Usually the same".
3. **Check each takeoff and the landing**: airport, runway and weather load by themselves once route and time are set.
   Each card shows the values used and a verdict; anything can be changed under "Edit runway & weather values".
   Values you typed are kept when the weather reloads ("↺ use fetched" drops them).
4. **Print**: download or open the PDF.

Sheets: one T/O data sheet per takeoff, whose landing box is the **emergency return** (same runway and weather, at
T/O weight), plus one sheet for the **landing at the destination** (weather at arrival time, everything at landing
mass). Two sheets per page, then the load sheet for the first departure.

Alternative method (step 2, "Usually the same" > "T/O data sheets"): **two sheets per takeoff** and no destination
sheet. The first is the immediate return (remarks start with e.g. "KGYR-KGYR"), the second lands at the leg's arrival
airport at that leg's landing mass (remarks "KGYR-KBXK"); everything else is identical. The arrival landing uses the
runway, weather and flaps of the next point (for an intermediate stop that is the weather fetched for its takeoff
time), so still enter or fetch every point including the destination. The results show an extra "Arrival landing"
tile and verdict line per leg. The setting is saved with the calculation.

Per leg: flight time and trip fuel; at each stop, ground time and an optional "refuel to" amount. Leg TOW = first TOM
minus the fuel burned on earlier legs (or ZFM + refuelled fuel). Density altitude = PA + 120 × (OAT − ISA), ISA rounded
to whole °C.

The draft you are entering is saved in this browser's localStorage. A flight saved on an earlier day keeps route,
people and settings; its date, time and weather are cleared. "New flight" keeps seat weights, baggage, trim, name, the
variable-wind setting and the sheet method. In a browser without a saved draft these come from your latest calculation.

## Accounts and tokens
Sign-in is required (Supabase Auth; accounts by admin invite only). **1 token = 1 calculation**:
- While drafting you see the inputs, the fetched runway/weather values with their source, density altitude, head/tailwind,
  masses and LAT airport limits — check or overwrite the weather, then press **Calculate (1 token)**.
- The inputs are frozen into a snapshot stored on the server; only then are distances, verdicts and the PDF shown, and the
  form is read-only. Any change means **Edit** → Calculate again → 1 more token. Identical inputs are never charged twice.
- **History** lists your calculations; opening one (view, print, download) is free, "Use as template" starts a new draft.
- `/admin.html` (admins): usage per user by period, grant/remove tokens, disable users, invite, calculation log with each
  snapshot's inputs.

Setup (Supabase project, SQL, SMTP, Vercel env vars): [docs/SETUP.md](docs/SETUP.md).

## OFP builder (`ofp.html`)
Plans a VFR flight and fills the LAT operational flight plan (form B02): click a route on the FAA TAC/sectional chart,
edit it on the map, and the navigation log (true/magnetic track, wind triangle, heading, ground speed, time, fuel) is
computed per leg; the form holds 18 legs and leg 1 is the departure-procedure leg. Print the filled form or export a
ForeFlight `.fpl`. **Send to T/O sheets** opens the T/O calculator with the leg's route, date, time, flight time, trip
fuel, take-off fuel and registration filled in (or offers to replace the route / add it as the next leg).
- Data: FAA TAC/sectional tiles; FAA ADDS airspace, airports and obstacles; terrain from AWS Terrarium tiles; winds aloft
  from Open-Meteo; magnetic variation from WMM2025. ATO points are placed by admins on `ofp.html`; users can keep
  personal points.
- Rules: time and fuel follow the B02 rules (see `nav.js`, tested with `node test.js`); safety checks (airspace,
  obstacles, terrain clearance) are in `safety.js`.
- Tokens: **3 tokens once per flight**. Finalising the same OFP again with the same date, departure and destination is
  free; a different flight costs 3 again. Printing and export need a finalised OFP.
- **Verify everything on the chart.** The checks and the nav log are an aid, not a substitute for flight preparation.
- Admin: `/admin.html` counts OFPs and lists them next to the calculation log; ledger rows show as "OFP".

## Airport data
- `airports.js`: LAT US approved airport list (THB Appendix A, 07 APR 2026): approvals, distance from GYR, notes, time
  zone, and limits checked automatically (LAT MTOM, max T/O temperature, max tailwind per runway, runways not
  authorized). Update it when the appendix changes.
- Field elevation from FAA ADDS (feet, same source as the Chart Supplement). Fallback: the LAT list value, then
  aviationweather.gov (whole metres, ±3 ft).
- Fields without an ICAO code: A39 and P08 report as KA39 / KP08. E63, 1AZ0, P20 and E25 have no weather station:
  runways come from FAA ADDS, METARs from the nearby stations listed in `airports.js` (E63: KGXF, then KBXK), shown
  as "from KGXF (5 NM away)", otherwise the forecast model.

## Weather
Loaded for each sheet's own time (takeoff times follow from departure time, flight times and ground times):
- time within 60 min of a METAR (now or up to 48 h back): that METAR (wind, temp, QNH)
- later: TAF wind if one covers the time, otherwise the NOAA GFS/HRRR model via Open-Meteo; model temp and QNH
  (QNH from model station pressure, marked "confirm with ATIS")
- all requests run in parallel with time limits; the forecast model is only waited for when no METAR covers the time.
  Airport data is cached in the browser for 30 days; weather older than 30 min reloads.

aviationweather.gov sends no CORS headers, so `api/aw/[ep].js` relays its airport/metar/taf endpoints.

**Deploy (Vercel, free Hobby plan):** import the GitHub repo in Vercel, framework preset "Other", no build command.
Every push to `main` deploys; other branches get preview URLs. (Hobby and the free Open-Meteo tier are non-commercial.)

Set `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` in Vercel (Production + Preview).

**Local:** export the same three variables, `node server.js`, then open http://localhost:8765 (it refuses to start without them). Add `?noserver` to the URL to hide the autofill.

## Files
- `perf.js` calculations (tables, interpolation, mass & balance, leg weights), tested with `node test.js`
- `app.js` form + PDF drawing, `autofill.js` form filling, `wx.js` weather selection and LAT limit checks (tested), `airports.js` LAT list, `fleet.js` BEM/CG, `api/aw/[ep].js` relay, `server.js` local server
- `snapshot.js` canonical calculation inputs (tested); `auth.js` sign-in client, `login.html`; `lib/verify.js` JWT check used by
  `middleware.js` (Vercel) and `server.js`; `api/config.js` public Supabase config; `admin.html`/`admin.js` and
  `api/admin/invite.js` admin panel; `db/schema.sql` tables, access rules and token functions
- OFP: `ofp.html`/`ofp.js` page, `nav.js` navigation maths + WMM (`vendor/wmm.js`), `ofpdata.js` airspace/obstacles/terrain/winds
  fetching, `safety.js` route safety checks, `ofpform.js` B02 form PDF and ForeFlight `.fpl` export, `ofpprint.js` print,
  `ato.js` ATO procedures table; `vendor/leaflet.*` map
- `form1002.pdf` source form, embedded as `form1002.js`; `vendor/` pdf-lib and pdf.js
