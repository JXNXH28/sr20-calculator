// Parser for FAA TFR detail XML (tfr.faa.gov/download/detail_*.xml, XNOTAM-Update). Pure, no dependencies, never throws.
// Each <TFRAreaGroup> is one area: <aseTFRArea> (altitudes), <abdMergedArea> (outline already expanded to GRC vertices, arcs and
// circles included) and <aseShapes> (the source shapes: CIR = circle, CWA/CCA = clockwise/counter-clockwise arc, GRC = vertex).
// Times (dateEffective/dateExpire) are UTC even though codeTimeZone names a local zone.

const first = (s, tag) => { const m = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>').exec(s); return m ? m[1].trim() : null; };
const all = (s, tag) => { const re = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>', 'g'); const o = []; let m; while ((m = re.exec(s))) o.push(m[1]); return o; };
const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// '33.12345678N' / '112.5W' / '033.5S' -> signed decimal degrees (S, W negative); NaN if malformed
function parseLatLon(s) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([NSEW])\s*$/i.exec(String(s));
  if (!m) return NaN;
  const v = parseFloat(m[1]);
  return /[SW]/i.test(m[2]) ? -v : v;
}

// Points along an arc about (clat,clon), radius rNm, from p0 to p1, every ~10 degrees. cw = clockwise (CWA) seen from above.
function arcPoints(clat, clon, rNm, p0, p1, cw) {
  const R = 3440.065, d2r = Math.PI / 180;
  const brg = p => Math.atan2((p[1] - clon) * Math.cos(clat * d2r), p[0] - clat) / d2r;
  const b0 = brg(p0), b1 = brg(p1);
  let sweep = cw ? ((b1 - b0) % 360 + 360) % 360 : -(((b0 - b1) % 360 + 360) % 360);
  if (sweep === 0) sweep = cw ? 360 : -360;
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / 10)), out = [];
  for (let i = 1; i < n; i++) {
    const b = (b0 + sweep * i / n) * d2r, dr = rNm / R, la = clat * d2r;
    const lat2 = Math.asin(Math.sin(la) * Math.cos(dr) + Math.cos(la) * Math.sin(dr) * Math.cos(b));
    const lon2 = clon * d2r + Math.atan2(Math.sin(b) * Math.sin(dr) * Math.cos(la), Math.cos(dr) - Math.sin(la) * Math.sin(lat2));
    out.push([lat2 / d2r, ((lon2 / d2r + 540) % 360) - 180]);
  }
  return out;
}

function vertex(avx) {
  const lat = parseLatLon(first(avx, 'geoLat')), lon = parseLatLon(first(avx, 'geoLong'));
  return isNaN(lat) || isNaN(lon) ? null : [lat, lon];
}

// Polygon outline from <Avx> elements; arcs (CWA/CCA) are approximated when no pre-expanded outline exists.
function avxToPoly(avxs) {
  const pts = [];
  for (let i = 0; i < avxs.length; i++) {
    const t = first(avxs[i], 'codeType');
    if (t === 'CWA' || t === 'CCA') {
      const clat = parseLatLon(first(avxs[i], 'geoLatArc')), clon = parseLatLon(first(avxs[i], 'geoLongArc'));
      const r = parseFloat(first(avxs[i], 'valRadiusArc'));
      const prev = pts[pts.length - 1], next = vertex(avxs[(i + 1) % avxs.length]);
      if (!isNaN(clat) && !isNaN(clon) && r > 0 && prev && next) for (const p of arcPoints(clat, clon, r, prev, next, t === 'CWA')) pts.push(p);
    } else { const v = vertex(avxs[i]); if (v) pts.push(v); }
  }
  return pts;
}

function altitude(block, which) {
  const val = parseFloat(first(block, 'valDistVer' + which)), uom = first(block, 'uomDistVer' + which), code = first(block, 'codeDistVer' + which);
  if (!isFinite(val)) return null;
  const ft = uom === 'FL' ? val * 100 : val;
  return { ft, agl: code === 'HEI' && ft > 0 };
}

function parseTfrXml(xml, opts) {
  try {
    if (typeof xml !== 'string' || xml.length < 50 || !xml.includes('<TFRAreaGroup>')) return null;
    opts = opts || {};
    const shapes = [];
    for (const g of all(xml, 'TFRAreaGroup')) {
      const area = first(g, 'aseTFRArea') || '';
      const lo = altitude(area, 'Lower'), hi = altitude(area, 'Upper');
      const alt = { floorFt: lo ? lo.ft : 0, ceilFt: hi ? hi.ft : 99999 };
      if (lo && lo.agl) alt.floorAgl = true;
      if (hi && hi.agl) alt.ceilAgl = true;
      const src = first(g, 'aseShapes') || '';
      const srcAvx = all(src, 'Avx');
      let shape = null;
      if (srcAvx.length === 1 && first(srcAvx[0], 'codeType') === 'CIR') {
        const lat = parseLatLon(first(srcAvx[0], 'geoLat')), lon = parseLatLon(first(srcAvx[0], 'geoLong'));
        let r = parseFloat(first(srcAvx[0], 'valRadiusArc'));
        const u = first(srcAvx[0], 'uomRadiusArc');
        if (u === 'KM') r /= 1.852; else if (u === 'SM') r /= 1.15078; else if (u === 'FT') r /= 6076.12; else if (u === 'M') r /= 1852;
        if (!isNaN(lat) && !isNaN(lon) && r > 0) shape = { kind: 'circle', lat, lon, radiusNm: r };
      }
      if (!shape) {
        let pts = all(first(g, 'abdMergedArea') || '', 'Avx').map(vertex).filter(Boolean);
        if (pts.length < 3) pts = avxToPoly(srcAvx);
        if (pts.length >= 3) shape = { kind: 'poly', pts };
      }
      if (shape) shapes.push(Object.assign(shape, alt));
    }
    if (!shapes.length) return null;
    const floorFt = Math.min(...shapes.map(s => s.floorFt)), ceilFt = Math.max(...shapes.map(s => s.ceilFt));
    const agl = shapes.some(s => s.floorAgl || s.ceilAgl);
    const iso = s => (s && /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?$/.test(s)) ? (s.length === 16 ? s + ':00' : s) + 'Z' : null;
    const nm = first(xml, 'txtNameCity');
    let text = unesc(first(xml, 'txtDescrUSNS') || first(xml, 'txtDescrTraditional') || opts.description || '').replace(/\s+/g, ' ').trim();
    if (text.length > 300) text = text.slice(0, 297) + '...';
    const seq = first(xml, 'noSeqNo'), yr = first(xml, 'dateIndexYear');
    const item = {
      id: opts.notamId || (seq && yr ? yr.slice(2) + '/' + seq : ''), type: opts.type || '',
      name: nm || opts.description || '', state: opts.state || '',
      from: iso(first(xml, 'dateEffective')), to: iso(first(xml, 'dateExpire')),
      floorFt, ceilFt, shapes, text,
    };
    if (agl) item.agl = true;
    return item;
  } catch (e) { return null; }
}

module.exports = { parseTfrXml, parseLatLon };
