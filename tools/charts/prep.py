#!/usr/bin/env python3
"""Helper for the FAA chart tile pipeline (runs inside the GDAL container).

Subcommands (all stdlib + numpy + osgeo):
  list      <charts.json>                       TSV of charts (layer, name, kind, geoname, polygon)
  edition   <kind> <geoname>                    "YYYY-MM-DD<TAB>zip-url" of the current FAA edition
  download  <url> <dest.zip>                    download with retries
  cutline   <tif> <poly> <out.geojson>          neatline polygon (pixel coords "x,y;x,y;...") -> georeferenced GeoJSON
  check     <tif> <poly>                        sanity-check polygon (map not cut, collar excluded); exit 1 on failure
  detect    <tif> [inset]                       measure the map-area neatline and print a charts.json "poly"
  grid      <tif> <poly> <zoom>                 tile-aligned EPSG:3857 extent + resolution
  bounds    <tif> <poly>                        lat/lon bounds of the neatline: s w n e
  srs       <tif> <out.wkt>                     write the chart's CRS as WKT
  manifest  <out_dir> <edition> <charts.json> <work_dir>   write current.json
"""
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone

API = "https://external-api.faa.gov/apra/vfr/%s/chart?geoname=%s&edition=current&format=tiff"
KINDS = {"tac": "tac", "sec": "sectional"}


def log(*a):
    print(*a, file=sys.stderr)


def http(url, accept=None):
    req = urllib.request.Request(url, headers={"User-Agent": "chart-tiles/1.0", **({"Accept": accept} if accept else {})})
    last = None
    for i in range(4):
        try:
            return urllib.request.urlopen(req, timeout=120)
        except Exception as e:  # noqa
            last = e
            time.sleep(2 + 3 * i)
    raise SystemExit("request failed: %s (%s)" % (url, last))


def cmd_list(path):
    cfg = json.load(open(path))
    for lname, lay in cfg["layers"].items():
        for ch in lay["charts"]:
            poly = ";".join("%d,%d" % tuple(p) for p in ch["poly"])
            print("\t".join([lname, ch["name"], KINDS[lname], ch["geoname"], poly]))


def cmd_edition(kind, geoname):
    d = json.load(http(API % (KINDS[kind], geoname.replace(" ", "%20")), "application/json"))
    e = d["edition"][0]
    m, dd, y = e["editionDate"].split("/")
    url = e["product"]["url"]
    if not url.startswith("https://aeronav.faa.gov/"):
        raise SystemExit("unexpected download host: " + url)
    print("%s-%s-%s\t%s" % (y, m.zfill(2), dd.zfill(2), url))


def cmd_download(url, dest):
    if not url.startswith("https://aeronav.faa.gov/"):
        raise SystemExit("refusing non-FAA host")
    with http(url) as r, open(dest, "wb") as f:
        while True:
            b = r.read(1 << 20)
            if not b:
                break
            f.write(b)


# ---------------------------------------------------------------- raster helpers
def open_chart(tif):
    import numpy as np
    from osgeo import gdal
    gdal.UseExceptions()
    ds = gdal.Open(tif)
    b = ds.GetRasterBand(1)
    ct = b.GetColorTable()
    if ct is None:
        raise SystemExit("expected a paletted GeoTIFF")
    lut = np.array([ct.GetColorEntry(i)[:3] for i in range(ct.GetCount())], dtype=np.uint8)
    lut_nw = lut.min(axis=1) < 235  # True where the colour is not (near) white
    return ds, b, lut_nw


def nonwhite(b, lut_nw, x, y, w, h):
    return lut_nw[b.ReadAsArray(x, y, w, h)]


def parse_poly(s):
    return [tuple(int(v) for v in p.split(",")) for p in s.split(";")]


def cmd_cutline(tif, poly, out):
    from osgeo import gdal
    gdal.UseExceptions()
    gt = gdal.Open(tif).GetGeoTransform()
    pts = parse_poly(poly)
    pts.append(pts[0])
    ring = [[gt[0] + x * gt[1], gt[3] + y * gt[5]] for x, y in pts]
    json.dump({"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {},
              "geometry": {"type": "Polygon", "coordinates": [ring]}}]}, open(out, "w"))


def point_in_poly(x, y, pts):
    inside = False
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def cmd_check(tif, poly):
    """Guard against a new FAA edition shifting the layout: just inside the polygon the
    map must be colour-filled (nothing cut off); just outside it must not be (collar leak).
    Individual probes may legitimately hit white map content, so only a majority failing is fatal."""
    ds, b, lut_nw = open_chart(tif)
    pts = parse_poly(poly)
    n = len(pts)
    W, H = ds.RasterXSize, ds.RasterYSize
    probes = 0
    cut = 0
    leak = 0
    for i in range(n):
        (x1, y1), (x2, y2) = pts[i], pts[(i + 1) % n]
        dx, dy = x2 - x1, y2 - y1
        ln = (dx * dx + dy * dy) ** 0.5
        if ln < 300:
            continue
        nx, ny = -dy / ln, dx / ln
        mx, my = (x1 + x2) / 2, (y1 + y2) / 2
        if not point_in_poly(mx + nx * 3, my + ny * 3, pts):
            nx, ny = -nx, -ny
        for t in (0.15, 0.3, 0.45, 0.6, 0.75, 0.9):
            cx, cy = x1 + dx * t, y1 + dy * t
            def frac(sign):
                v = []
                for d in range(8, 40, 4):
                    for s in (-20, 0, 20):
                        px = int(cx + sign * nx * d + dx / ln * s)
                        py = int(cy + sign * ny * d + dy / ln * s)
                        if 0 <= px < W and 0 <= py < H:
                            v.append(bool(nonwhite(b, lut_nw, px, py, 1, 1)[0, 0]))
                return sum(v) / len(v) if v else None
            fi, fo = frac(1), frac(-1)
            if fi is None or fo is None:      # probe falls on the image border
                continue
            probes += 1
            cut += fi < 0.5
            leak += fo > 0.97
    log("check %s: %d probes, %d inside-mostly-white, %d outside-fully-coloured" % (os.path.basename(tif), probes, cut, leak))
    if probes and (cut / probes > 0.25 or leak / probes > 0.5):
        raise SystemExit("neatline polygon does not fit this edition of %s - re-measure with prep.py detect and update charts.json" % tif)


def first_run(a, n=30, th=0.9):
    for i in range(len(a) - n):
        if a[i] > 0.5 and a[i:i + n].mean() > th:
            return i
    return -1


def last_run(a, n=6, th=0.9):
    r = first_run(a[::-1], n, th)
    return len(a) - 1 - r if r >= 0 else -1


def fit(pts):
    """robust line fit through (t, v) pairs: v = a + b*t"""
    import numpy as np
    t = np.array([p[0] for p in pts], float)
    v = np.array([p[1] for p in pts], float)
    for _ in range(3):
        b, a = np.polyfit(t, v, 1)
        res = np.abs(v - (a + b * t))
        keep = res <= max(3.0, 2.5 * np.median(res))
        if keep.all() or keep.sum() < 3:
            break
        t, v = t[keep], v[keep]
    return a, b


def cmd_detect(tif, inset=2):
    import numpy as np
    ds, b, lut_nw = open_chart(tif)
    W, H = ds.RasterXSize, ds.RasterYSize
    sc = 4
    from osgeo import gdal
    idx = b.ReadAsArray(buf_xsize=W // sc, buf_ysize=H // sc, resample_alg=gdal.GRIORA_NearestNeighbour)
    nw = lut_nw[idx]
    h, w = nw.shape
    rowfrac = nw[:, int(w * 0.5):int(w * 0.95)].mean(axis=1)
    colfrac = nw[int(h * 0.3):int(h * 0.9), :].mean(axis=0)
    def sustained(a, n=10, th=0.6):
        ok = (a > th).astype(int)
        c = np.convolve(ok, np.ones(n, int), "valid")
        i = np.where(c == n)[0]
        return (i[0] * sc, (i[-1] + n) * sc) if len(i) else (None, None)
    top_c, bot_c = sustained(rowfrac)
    left_c, right_c = sustained(colfrac)
    log("coarse: left %s right %s top %s bottom %s" % (left_c, right_c, top_c, bot_c))
    xs = np.linspace(left_c + 0.1 * (right_c - left_c), right_c - 0.1 * (right_c - left_c), 10).astype(int)
    ys = np.linspace(top_c + 0.1 * (bot_c - top_c), bot_c - 0.1 * (bot_c - top_c), 10).astype(int)
    T, B, L, R = [], [], [], []
    for x in xs:
        a = nonwhite(b, lut_nw, int(x), max(0, top_c - 80), 24, 160).mean(axis=1)
        i = first_run(a)
        if i >= 0:
            T.append((x, i + max(0, top_c - 80)))
        y0 = min(H - 1, bot_c + 80) - 160
        a = nonwhite(b, lut_nw, int(x), y0, 24, 160).mean(axis=1)
        i = last_run(a, 30)
        if i >= 0:
            B.append((x, i + y0))
    for y in ys:
        x0 = max(0, left_c - 300)
        a = nonwhite(b, lut_nw, x0, int(y), 700, 24).mean(axis=0)
        i = first_run(a)
        if i >= 0:
            L.append((y, i + x0))
        x1 = min(W, right_c + 100) - 400
        a = nonwhite(b, lut_nw, x1, int(y), 400, 24).mean(axis=0)
        i = last_run(a, 6)
        if i >= 0:
            R.append((y, i + x1))
    ta, tb = fit(T); ba, bb = fit(B); la, lb = fit(L); ra, rb = fit(R)
    log("top y=%.1f%+.5f*x  bottom y=%.1f%+.5f*x  left x=%.1f%+.5f*y  right x=%.1f%+.5f*y" % (ta, tb, ba, bb, la, lb, ra, rb))
    ta += inset; ba -= inset; la += inset; ra -= inset
    def corner(ya, yb, xa, xb):  # y = ya + yb*x ; x = xa + xb*y
        y = (ya + yb * xa) / (1 - yb * xb)
        x = xa + xb * y
        return [int(round(x)), int(round(y))]
    poly = [corner(ta, tb, la, lb), corner(ta, tb, ra, rb), corner(ba, bb, ra, rb), corner(ba, bb, la, lb)]
    for p in poly:
        p[0] = min(max(p[0], 0), W)
        p[1] = min(max(p[1], 0), H)
    print(json.dumps({"size": [W, H], "poly": poly}))


def poly_3857_and_lonlat(tif, poly):
    """densified neatline in EPSG:3857 and in lon/lat"""
    from osgeo import gdal, osr
    gdal.UseExceptions()
    ds = gdal.Open(tif)
    gt = ds.GetGeoTransform()
    src = ds.GetSpatialRef()
    src.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    out = []
    for code in (3857, 4326):
        dst = osr.SpatialReference()
        dst.ImportFromEPSG(code)
        dst.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        out.append(osr.CoordinateTransformation(src, dst))
    pts = parse_poly(poly)
    dense = []
    for i in range(len(pts)):
        (x1, y1), (x2, y2) = pts[i], pts[(i + 1) % len(pts)]
        n = max(2, int(max(abs(x2 - x1), abs(y2 - y1)) // 200))
        for k in range(n):
            dense.append((x1 + (x2 - x1) * k / n, y1 + (y2 - y1) * k / n))
    geo = [(gt[0] + x * gt[1], gt[3] + y * gt[5]) for x, y in dense]
    return [[t.TransformPoint(gx, gy)[:2] for gx, gy in geo] for t in out]


def cmd_grid(tif, poly, zoom):
    """tile-aligned EPSG:3857 extent covering the neatline at `zoom`: xmin ymin xmax ymax res"""
    import math
    z = int(zoom)
    m3, _ = poly_3857_and_lonlat(tif, poly)
    full = 2 * 20037508.342789244
    tile = full / (2 ** z)
    xs = [p[0] for p in m3]
    ys = [p[1] for p in m3]
    o = -20037508.342789244
    x0 = o + math.floor((min(xs) - o) / tile) * tile
    x1 = o + math.ceil((max(xs) - o) / tile) * tile
    y0 = o + math.floor((min(ys) - o) / tile) * tile
    y1 = o + math.ceil((max(ys) - o) / tile) * tile
    print("%.6f %.6f %.6f %.6f %.9f" % (x0, y0, x1, y1, tile / 256))


def cmd_bounds(tif, poly):
    _, ll = poly_3857_and_lonlat(tif, poly)
    print("%.5f %.5f %.5f %.5f" % (min(p[1] for p in ll), min(p[0] for p in ll), max(p[1] for p in ll), max(p[0] for p in ll)))


def cmd_srs(tif, out):
    from osgeo import gdal
    gdal.UseExceptions()
    open(out, "w").write(gdal.Open(tif).GetSpatialRef().ExportToWkt())


def cmd_manifest(out_dir, edition, charts_json, work_dir):
    cfg = json.load(open(charts_json))
    layers = {}
    for lname, lay in cfg["layers"].items():
        bf = os.path.join(work_dir, "bounds_%s.txt" % lname)
        if not os.path.exists(bf):
            continue
        rows = [[float(v) for v in l.split()] for l in open(bf) if l.strip()]
        layers[lname] = {"minZoom": lay["minZoom"], "maxZoom": lay["maxZoom"],
                         "bounds": [[round(min(r[0] for r in rows), 4), round(min(r[1] for r in rows), 4)],
                                    [round(max(r[2] for r in rows), 4), round(max(r[3] for r in rows), 4)]]}
    doc = {"edition": edition, "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "layers": layers}
    json.dump(doc, open(os.path.join(out_dir, "current.json"), "w"), indent=1)


if __name__ == "__main__":
    c, a = sys.argv[1], sys.argv[2:]
    {"list": cmd_list, "edition": cmd_edition, "download": cmd_download, "cutline": cmd_cutline,
     "check": cmd_check, "grid": cmd_grid, "bounds": cmd_bounds, "srs": cmd_srs, "detect": lambda t, i=2: cmd_detect(t, int(i)), "manifest": cmd_manifest}[c](*a)
