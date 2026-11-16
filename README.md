# SR20 T/O data sheet & load sheet calculator

Fills LAT US form 1002 (Single-Engine Land T/O Data Sheet + SR20 Load Sheet) from the
LAT PA Training Handbook SR20 Rev 06 tables (linear interpolation). Everything runs in the browser;
the filled PDF is generated client-side onto the original form.

**Training aid only. Verify all values against the THB, the POH and the aircraft weight report.**

## Use
Open the site (or `index.html`), enter the flight, then **Download PDF** or **Open to print**.
Replace the prefilled example BEM, CG and weights with your aircraft's data.

## Airport and weather autofill
Enter the ICAO code and time, then press **Fetch**. Data for the requested time:
- airport, elevation, magnetic variation and runway courses: aviationweather.gov
- time within 60 min of a METAR (now or up to 48 h back): that METAR (wind, temp, QNH)
- later: TAF wind if one covers the time, otherwise the NOAA GFS/HRRR model via Open-Meteo; model temp and QNH
  (QNH from model station pressure, marked "confirm with ATIS")

aviationweather.gov sends no CORS headers, so `api/aw/[ep].js` relays its airport/metar/taf endpoints.

**Deploy (Vercel, free Hobby plan):** import the GitHub repo in Vercel, framework preset "Other", no build command.
Every push to `main` deploys; other branches get preview URLs. (Hobby and the free Open-Meteo tier are non-commercial.)

**Local:** `node server.js`, then open http://localhost:8765. Add `?noserver` to the URL to hide the autofill.

## Files
- `perf.js` calculations (tables, interpolation, mass & balance), tested with `node test.js`
- `app.js` form + PDF drawing, `autofill.js` form filling, `wx.js` weather selection logic (tested), `api/aw/[ep].js` relay, `server.js` local server
- `form1002.pdf` source form, embedded as `form1002.js`; `vendor/` pdf-lib and pdf.js
