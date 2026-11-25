// Read-only relay for aviationweather.gov (it sends no CORS headers). Used by Vercel (api/ routing) and server.js.
// GET /api/aw/{airport|metar|taf}?ids=KSEF[&hours=N]
// GET /api/aw/{airsigmet|cwa}   GET /api/aw/gairmet?type=sierra|tango|zulu   GET /api/aw/pirep?bbox=lat0,lon0,lat1,lon1[&age=1-6]
const { verifyJwt, tokenFromRequest } = require('../../lib/verify.js');
const CACHE = { airport: 86400, metar: 60, taf: 60, airsigmet: 300, cwa: 300, gairmet: 300, pirep: 120 };
const num = /^-?\d{1,3}(\.\d+)?$/;

// Validates the query for endpoint ep; returns the upstream URLSearchParams, or null when the request is bad.
// "lat0,lon0,lat1,lon1" inside the US area, at most maxDeg x maxDeg -> the same string, else null
function bboxOf(bbox, maxDeg) {
  const p = String(bbox || '').split(',');
  if (p.length !== 4 || !p.every(s => num.test(s))) return null;
  const [la0, lo0, la1, lo1] = p.map(Number);
  if (la0 < 15 || la1 > 72 || lo0 < -180 || lo1 > -60 || !(la0 < la1) || !(lo0 < lo1) || la1 - la0 > maxDeg || lo1 - lo0 > maxDeg) return null;
  return p.join(',');
}

function validate(ep, sp) {
  if (!Object.prototype.hasOwnProperty.call(CACHE, ep)) return null;
  const q = new URLSearchParams();
  if (ep === 'taf' && sp.get('bbox') !== null && sp.get('ids') === null) {
    const b = bboxOf(sp.get('bbox'), 3);
    if (!b) return null;
    q.set('bbox', b);
  } else if (ep === 'airport' || ep === 'metar' || ep === 'taf') {
    const ids = sp.get('ids') || '', hours = sp.get('hours');
    if (!/^[A-Za-z0-9]{3,4}$/.test(ids)) return null;
    if (hours !== null && (!/^\d{1,2}$/.test(hours) || +hours > 48)) return null;
    q.set('ids', ids.toUpperCase());
    if (hours !== null && ep === 'metar') q.set('hours', hours);
  } else if (ep === 'gairmet') {
    const type = sp.get('type');
    if (!['sierra', 'tango', 'zulu'].includes(type)) return null;
    q.set('type', type);
  } else if (ep === 'pirep') {
    const bbox = bboxOf(sp.get('bbox'), 15), age = sp.get('age');
    if (!bbox) return null;
    if (age !== null && (!/^[1-6]$/.test(age))) return null;
    q.set('bbox', bbox); q.set('age', age === null ? '3' : age);
  }
  q.set('format', 'json');
  return q;
}

async function handler(req, res) {
  if (!(await verifyJwt(tokenFromRequest(req.headers), process.env.SUPABASE_URL))) {
    res.statusCode = 401; res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end('{"error":"unauthenticated"}');
  }
  const url = new URL(req.url, 'http://localhost');
  const ep = url.pathname.split('/').pop();
  const q = req.method === 'GET' ? validate(ep, url.searchParams) : null;
  if (!q) { res.statusCode = 400; return res.end('bad request'); }
  try {
    const r = await fetch(`https://aviationweather.gov/api/data/${ep}?${q}`, { headers: { 'User-Agent': 'sr20-calculator', Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    res.statusCode = r.status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (r.ok) res.setHeader('Cache-Control', `public, s-maxage=${CACHE[ep]}, stale-while-revalidate=${CACHE[ep]}`);
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) { res.statusCode = 502; res.end('upstream error: ' + e.message); }
}
module.exports = handler;
module.exports.validate = validate;
