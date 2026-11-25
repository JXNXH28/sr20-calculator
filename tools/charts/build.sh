#!/usr/bin/env bash
# Build XYZ WEBP tile pyramids from the current FAA full-resolution GeoTIFF charts.
#
# Runs inside ghcr.io/osgeo/gdal:ubuntu-small-latest (GDAL >= 3.8 with gdal2tiles + WEBP),
# or anywhere gdal-bin + python3-gdal + python3-numpy are installed:
#   docker run --rm -v "$PWD:/repo" -w /repo ghcr.io/osgeo/gdal:ubuntu-small-latest bash tools/charts/build.sh
#
# Env (all optional):
#   OUT         output dir                (default tools/charts/out)
#   WORK        scratch dir, large        (default tools/charts/work)
#   ONLY        space separated layer and/or chart names (spaces as _): "sec", "tac Phoenix"
#   PROCESSES   gdal2tiles workers        (default: all cores)
#   WEBP_Q      WEBP quality              (default 82)
#   KEEP_WORK=1 keep downloads/warped intermediates
#
# Result:  $OUT/<edition YYYY-MM-DD>/{tac,sec}/{z}/{x}/{y}.webp   and   $OUT/current.json
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${OUT:-$HERE/out}"
WORK="${WORK:-$HERE/work}"
ONLY="${ONLY:-}"
PROCESSES="${PROCESSES:-$(nproc)}"
WEBP_Q="${WEBP_Q:-82}"
PREP=(python3 -I "$HERE/prep.py")
export GDAL_NUM_THREADS=ALL_CPUS GDAL_CACHEMAX=1024 CPL_LOG=/dev/null

mkdir -p "$OUT" "$WORK/dl" "$WORK/warp"
rm -f "$WORK"/bounds_*.txt
T0=$(date +%s)
say() { echo "[$(date +%H:%M:%S)] $*" >&2; }

wanted() { [ -z "$ONLY" ] || [[ " $ONLY " == *" $1 "* ]] || [[ " $ONLY " == *" ${2// /_} "* ]]; }

# ---------------------------------------------------------------- 1. editions + download
declare -A EDITIONS
EDITION=""
while IFS=$'\t' read -r layer name kind geoname poly; do
  wanted "$layer" "$name" || continue
  IFS=$'\t' read -r ed url < <("${PREP[@]}" edition "$layer" "$geoname")
  say "$layer / $name: FAA edition $ed  $url"
  [[ "$ed" > "$EDITION" ]] && EDITION="$ed"
  slug="${layer}_${name// /_}"
  d="$WORK/dl/$slug"
  if ! compgen -G "$d/*.tif" > /dev/null || [ ! -f "$d/.edition" ] || [ "$(cat "$d/.edition")" != "$ed" ]; then
    rm -rf "$d"; mkdir -p "$d"
    "${PREP[@]}" download "$url" "$d/chart.zip"
    # only the map GeoTIFF is needed (skips the flyway chart and the .htm); never extract paths outside $d
    unzip -oq -j "$d/chart.zip" '*.tif' '*.TIF' -x '*FLY*' -d "$d" 2>/dev/null || unzip -oq -j "$d/chart.zip" -d "$d"
    rm -f "$d/chart.zip"
    echo "$ed" > "$d/.edition"
  fi
done < <("${PREP[@]}" list "$HERE/charts.json")
[ -n "$EDITION" ] || { echo "no charts selected"; exit 1; }
say "cycle edition: $EDITION"

# ---------------------------------------------------------------- 2. clip + warp every chart
declare -A WARPED   # layer -> list of warped tifs
while IFS=$'\t' read -r layer name kind geoname poly; do
  wanted "$layer" "$name" || continue
  slug="${layer}_${name// /_}"
  d="$WORK/dl/$slug"
  zoom=$(python3 -I -c "import json,sys;print(json.load(open('$HERE/charts.json'))['layers']['$layer']['warpZoom'])")
  tif=$(ls -S "$d"/*.tif | head -1)   # the map is the largest GeoTIFF in the zip
  say "$slug: checking neatline polygon"
  "${PREP[@]}" check "$tif" "$poly"
  "${PREP[@]}" cutline "$tif" "$poly" "$WORK/warp/$slug.cut.geojson"
  "${PREP[@]}" srs "$tif" "$WORK/warp/$slug.srs"
  read -r x0 y0 x1 y1 res < <("${PREP[@]}" grid "$tif" "$poly" "$zoom")
  "${PREP[@]}" bounds "$tif" "$poly" >> "$WORK/bounds_$layer.txt"
  say "$slug: palette -> RGBA, clip to neatline, warp to EPSG:3857 @ z$zoom grid (res $res)"
  gdal_translate -q -of VRT -expand rgba "$tif" "$WORK/warp/$slug.rgba.vrt"
  gdalwarp -q -overwrite -multi -wo NUM_THREADS=ALL_CPUS \
    -t_srs EPSG:3857 -r lanczos -te $x0 $y0 $x1 $y1 -tr $res $res \
    -cutline "$WORK/warp/$slug.cut.geojson" -cutline_srs "$WORK/warp/$slug.srs" \
    -dstalpha -wm 1500 \
    -co TILED=YES -co COMPRESS=DEFLATE -co PREDICTOR=2 -co ZLEVEL=3 -co BIGTIFF=YES -co NUM_THREADS=ALL_CPUS \
    "$WORK/warp/$slug.rgba.vrt" "$WORK/warp/$slug.tif"
  rm -f "$WORK/warp/$slug.rgba.vrt"
  [ "${KEEP_WORK:-0}" = 1 ] || rm -rf "$d"
  WARPED[$layer]+="$WORK/warp/$slug.tif "
done < <("${PREP[@]}" list "$HERE/charts.json")

# ---------------------------------------------------------------- 3. mosaic + tile
DEST="$OUT/$EDITION"
mkdir -p "$DEST"
for layer in "${!WARPED[@]}"; do
  minz=$(python3 -I -c "import json;print(json.load(open('$HERE/charts.json'))['layers']['$layer']['minZoom'])")
  maxz=$(python3 -I -c "import json;print(json.load(open('$HERE/charts.json'))['layers']['$layer']['maxZoom'])")
  gdalbuildvrt -q -overwrite "$WORK/warp/$layer.vrt" ${WARPED[$layer]}
  rm -rf "$DEST/$layer"
  say "$layer: gdal2tiles z$minz-$maxz, $PROCESSES processes"
  gdal2tiles --xyz -p mercator -z "$minz-$maxz" -r lanczos --tilesize=256 \
    --tiledriver=WEBP --webp-quality="$WEBP_Q" --exclude -w none --processes="$PROCESSES" -q \
    "$WORK/warp/$layer.vrt" "$DEST/$layer"
  find "$DEST/$layer" -type f ! -name '*.webp' -delete   # drop tilemapresource/openlayers leftovers
  find "$DEST/$layer" -type d -empty -delete
  say "$layer: $(find "$DEST/$layer" -name '*.webp' | wc -l) tiles, $(du -sh "$DEST/$layer" | cut -f1)"
done

"${PREP[@]}" manifest "$OUT" "$EDITION" "$HERE/charts.json" "$WORK"
[ "${KEEP_WORK:-0}" = 1 ] || rm -rf "$WORK/warp"
say "done in $(( $(date +%s) - T0 )) s -> $OUT/current.json"
cat "$OUT/current.json" >&2
