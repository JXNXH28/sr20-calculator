# SR20 T/O data sheet & load sheet calculator

Fills LAT US form 1002 (Single-Engine Land T/O Data Sheet + SR20 Load Sheet) from the
LAT PA Training Handbook SR20 Rev 06 tables (linear interpolation). Everything runs in the browser;
the filled PDF is generated client-side onto the original form.

**Training aid only. Verify all values against the THB, the POH and the aircraft weight report.**

## Use
Open the site (or `index.html`), enter the flight, then **Download PDF** or **Open to print**.
Replace the prefilled example BEM, CG and weights with your aircraft's data.

## Optional: airport and weather autofill (local only)
Needs Node. NOAA does not allow browser calls, so a tiny relay serves the page:

    node server.js        # then open http://localhost:8765

On any other host (e.g. GitHub Pages) the autofill is hidden and the fields are entered by hand.

## Files
- `perf.js` calculations (tables, interpolation, mass & balance), tested with `node test.js`
- `app.js` form + PDF drawing, `autofill.js` weather/airport lookup, `server.js` local relay
- `form1002.pdf` source form, embedded as `form1002.js`; `vendor/` pdf-lib and pdf.js
