# SR20 T/O data sheet & load sheet calculator

Fills LAT US form 1002 (Single-Engine Land T/O Data Sheet + SR20 Load Sheet) from the
LAT PA Training Handbook SR20 Rev 06 tables (linear interpolation). Everything runs in the browser;
the filled PDF is generated client-side onto the original form.

**Training aid only. Verify all values against the THB, the POH and the aircraft weight report.**

## Use
Enter the date, registration (autocompletes from the fleet table, which fills BEM and CG), and the route, for example
`KGYR → KBXK → KGYR`. Stops autocomplete from the LAT approved airport list. Each takeoff gets its own T/O data sheet
(two per page). Then enter seats, baggage and fuel, and press **Fetch airports & weather**.

Per leg: flight time and trip fuel; at each stop, ground time and an optional "refuel to" amount. Leg TOW = first TOM
minus the fuel burned on earlier legs (or ZFM + refuelled fuel). The load sheet is for the first departure; its trip
fuel is everything burned before the first refuel.

The landing box on each T/O sheet is the **emergency return**: same airport, runway and weather as that takeoff, at
T/O weight, flaps 100 (override per leg under "Runway, weather & emergency landing").

## Airport data
- `airports.js`: LAT US approved airport list (THB Appendix A, 07 APR 2026): approvals, distance from GYR, notes, and
  limits checked automatically (LAT MTOM, max T/O temperature, max tailwind per runway, runways not authorized for
  takeoff, which are also skipped by the runway auto-pick). Update it when the appendix changes.
- Field elevation from FAA ADDS (feet, same source as the Chart Supplement), queried live. Fallback: the LAT list
  value, then aviationweather.gov (whole metres, ±3 ft).

## Weather autofill
Data for each takeoff's time (leg 1: the departure time typed, or now; later legs: previous takeoff + flight time + ground time):
- airport, magnetic variation and runway courses: aviationweather.gov
- time within 60 min of a METAR (now or up to 48 h back): that METAR (wind, temp, QNH)
- later: TAF wind if one covers the time, otherwise the NOAA GFS/HRRR model via Open-Meteo; model temp and QNH
  (QNH from model station pressure, marked "confirm with ATIS")

aviationweather.gov sends no CORS headers, so `api/aw/[ep].js` relays its airport/metar/taf endpoints.

**Deploy (Vercel, free Hobby plan):** import the GitHub repo in Vercel, framework preset "Other", no build command.
Every push to `main` deploys; other branches get preview URLs. (Hobby and the free Open-Meteo tier are non-commercial.)

**Local:** `node server.js`, then open http://localhost:8765. Add `?noserver` to the URL to hide the autofill.

## Files
- `perf.js` calculations (tables, interpolation, mass & balance, leg weights), tested with `node test.js`
- `app.js` form + PDF drawing, `autofill.js` form filling, `wx.js` weather selection and LAT limit checks (tested), `airports.js` LAT list, `fleet.js` BEM/CG, `api/aw/[ep].js` relay, `server.js` local server
- `form1002.pdf` source form, embedded as `form1002.js`; `vendor/` pdf-lib and pdf.js
