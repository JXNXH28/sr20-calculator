// Read-only relay for aviationweather.gov (it sends no CORS headers). Used by Vercel (api/ routing) and server.js.
// GET /api/aw/{airport|metar|taf}?ids=KSEF[&hours=N]
const { verifyJwt, tokenFromRequest } = require('../../lib/verify.js');
const CACHE = { airport: 86400, metar: 60, taf: 60 };

module.exports = async function handler(req, res) {
  if (!(await verifyJwt(tokenFromRequest(req.headers), process.env.SUPABASE_URL))) {
    res.statusCode = 401; res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end('{"error":"unauthenticated"}');
  }
  const url = new URL(req.url, 'http://localhost');
  const ep = url.pathname.split('/').pop();
  const ids = url.searchParams.get('ids') || '';
  const hours = url.searchParams.get('hours');
  if (req.method !== 'GET' || !(ep in CACHE) || !/^[A-Za-z0-9]{3,4}$/.test(ids) || (hours !== null && !/^\d{1,2}$/.test(hours) || +hours > 48)) {
    res.statusCode = 400; return res.end('bad request');
  }
  const q = new URLSearchParams({ ids: ids.toUpperCase(), format: 'json' });
  if (hours !== null && ep === 'metar') q.set('hours', hours);
  try {
    const r = await fetch(`https://aviationweather.gov/api/data/${ep}?${q}`, { headers: { 'User-Agent': 'sr20-calculator', Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    res.statusCode = r.status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (r.ok) res.setHeader('Cache-Control', `public, s-maxage=${CACHE[ep]}, stale-while-revalidate=${CACHE[ep]}`);
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) { res.statusCode = 502; res.end('upstream error: ' + e.message); }
};
