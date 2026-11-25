# Own VFR chart tiles (TAC + sectionals) on Cloudflare R2

The FAA's public tile services (VFR_Terminal / VFR_Sectional) stop at zoom 12 and are low-quality JPEG.
This pipeline cuts the FAA's full-resolution GeoTIFF charts into our own sharper WEBP tiles, hosts them on
Cloudflare R2, and refreshes them automatically every 56-day chart cycle.

```
FAA API  ->  tools/charts/build.sh (GDAL)  ->  tools/charts/upload.sh (aws s3 -> R2)  ->  $CHARTS_PUBLIC_URL
             .github/workflows/charts.yml runs both, weekly + on demand
```

## What gets built

| Layer | Charts | Zoom | Source resolution |
|---|---|---|---|
| `tac` | Phoenix TAC | 9-14 | 1:250,000, 300 dpi (21 m/px) |
| `sec` | Phoenix, Los Angeles, Las Vegas sectionals | 6-13 | 1:500,000, 300 dpi (42 m/px) |

Add charts by editing `tools/charts/charts.json` (FAA geoname, neatline polygon, zooms).

Steps in `build.sh` (runs in `ghcr.io/osgeo/gdal:ubuntu-small-latest`):

1. Ask the FAA API for the current edition of each chart, download the zip, extract the map GeoTIFF (flyway charts ignored).
2. Expand the 256-colour palette to RGBA and clip to the chart's **neatline polygon** (`charts.json`, pixel coordinates).
   Legend/collar panels, margin text and the Los Angeles terminal-area inset are outside the polygon, so they never cover a
   neighbouring chart. The slanted meridian edges of the sectionals are handled by the polygon; `prep.py check` verifies
   that the polygon still fits each new edition (map not cut, collar not leaking) and fails the build otherwise.
3. Warp each chart to EPSG:3857 (Lanczos) on the tile grid, transparent outside its neatline.
4. Mosaic the sectionals (VRT) and tile with `gdal2tiles --xyz`, 256 px WEBP (quality 82) with alpha. Fully transparent tiles are skipped.
5. Write `out/current.json`.

Output layout (this is exactly the bucket layout):

```
current.json                                   {"edition":"2026-10-29","generated":"...","layers":{"tac":{"minZoom":9,"maxZoom":14,"bounds":[[s,w],[n,e]]},"sec":{...}}}
2026-10-29/tac/{z}/{x}/{y}.webp
2026-10-29/sec/{z}/{x}/{y}.webp
```

Tile URL for the page: `${CHARTS_PUBLIC_URL}/${edition}/{tac|sec}/{z}/{x}/{y}.webp` with Leaflet's default XYZ numbering (no `tms`).
Read `current.json` first (short cache); tiles are immutable per edition. Missing tiles (outside coverage) return 404, which Leaflet
treats as "no tile" -- set `errorTileUrl` to a transparent pixel to keep the console quiet.

`upload.sh` uploads all tiles first and `current.json` last, so the page switches to a new edition atomically, then deletes
all but the newest two editions (current + previous, so open browser tabs keep working).

## One-time setup (Cloudflare + GitHub)

1. **Cloudflare account** (free) -> *R2 Object Storage* -> enable R2 (a payment method is requested, but the free tier below covers this use).
2. **Create bucket**, e.g. `ofp-charts` (location: automatic).
3. **Public access** for the bucket (*Settings*):
   - quick: *Public Development URL* -> **Allow Access** -> gives `https://pub-<hash>.r2.dev` (rate-limited, no CDN cache; fine for testing), or
   - recommended: *Custom Domains* -> add e.g. `charts.<your-domain>` (domain must be on Cloudflare DNS). This enables Cloudflare's CDN cache, so most tile reads never reach R2.
4. **CORS** (bucket *Settings* -> *CORS policy*) so the page can fetch `current.json`:
   `[{"AllowedOrigins":["https://<your-site>","http://localhost:3000"],"AllowedMethods":["GET","HEAD"],"AllowedHeaders":["*"],"MaxAgeSeconds":86400}]`
5. **API token**: R2 overview -> *Manage API tokens* -> *Create API token* -> permission **Object Read & Write**, scoped to *this bucket only*.
   Copy the *Access Key ID* and *Secret Access Key* (shown once). Your **Account ID** is on the R2 overview page.
6. **GitHub** -> repo *Settings* -> *Secrets and variables* -> *Actions*:
   - Secrets: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (bucket name).
   - Variable (not secret): `CHARTS_PUBLIC_URL` = the public base URL from step 3, no trailing slash.
7. *Actions* -> **Chart tiles** -> *Run workflow* with `force` ticked (first run). When it is green,
   `${CHARTS_PUBLIC_URL}/current.json` should load in a browser.

After that the workflow runs every Monday: it compares the FAA's current Phoenix sectional edition date with `current.json`
on R2 and does nothing unless a new edition is out (about every 56 days). Re-run manually with `force` any time.

## Costs (Cloudflare R2)

- Free tier per month: 10 GB storage, 1 M Class A (write/list) operations, 10 M Class B (read) operations. **Egress is free.**
- Storage: two editions are kept, about 1.4 GB total (see below) -- well inside 10 GB.
- Writes: one full upload is about 79,400 PUTs (Class A) per 56-day cycle, <10 % of the monthly allowance. Weekly no-op runs make zero R2 calls
  (the check reads the public URL; the AWS sync is skipped).
- Reads: each tile view is one Class B read unless served from Cloudflare's cache (custom domain). 10 M/month is thousands of map sessions; beyond that Class B is $0.36 per million.
- GitHub Actions: public repo free; private repos spend roughly 25-30 minutes of runner time per cycle (the 2000 free minutes/month are plenty).

## Measured locally (edition 2026-10-29, 8-core Docker on a Mac)

| Layer | Tiles | Size | Per zoom (tiles) |
|---|---|---|---|
| `tac` (z9-14) | 7,585 | 56 MB | 9: 9, 10: 36, 11: 110, 12: 378, 13: 1,440, 14: 5,612 |
| `sec` (z6-13) | 71,821 | 641 MB | 6: 7, 7: 22, 8: 69, 9: 246, 10: 890, 11: 3,464, 12: 13,543, 13: 53,580 |

Total build time about 21 minutes (download 1 min, warp ~2 min per chart, tiling ~19 min); peak scratch disk about 2 GB (GitHub's 14 GB is fine).
Sectional z13 is half of all tiles and about 410 MB, yet the sectional's native resolution is just above z12; if storage or upload counts ever matter,
set `"maxZoom": 12` for `sec` in `charts.json` (about 18 k tiles, 245 MB) and let Leaflet overzoom (`maxNativeZoom: 12`). TAC z14 is likewise a 2x upscale of z13 (native is about z13).

## Running locally

```
docker run --rm -v "$PWD:/repo" -w /repo ghcr.io/osgeo/gdal:ubuntu-small-latest bash tools/charts/build.sh
# env: ONLY="tac" (or "sec", "Phoenix"), OUT=..., WORK=..., PROCESSES=4, WEBP_Q=82
```

Output goes to `tools/charts/out/` (git-ignored). Test tiles with any static server, e.g. `python3 -m http.server -d tools/charts/out`.
Local upload test needs the four `R2_*` env vars and the AWS CLI: `bash tools/charts/upload.sh`.

## Maintenance

- **New edition changes the layout** (collar moves): `build.sh` stops at the polygon check with a clear message. Re-measure with
  `python3 -I tools/charts/prep.py detect "<chart>.tif"` (inside the GDAL container), review the crop visually, update `poly` in `charts.json`.
  `detect` fits the four edges of a rectangular/slanted map; the Los Angeles polygon was measured by hand because a legend panel and the LA terminal inset overlap its map.
- **Add a chart**: add an entry (FAA geoname as used by `external-api.faa.gov/apra/vfr/<tac|sectional>/chart?geoname=...`), run `detect`, build.
- The FAA publishes charts as US public-domain data; keep the FAA attribution/"not for navigation" disclaimer on the OFP page.
