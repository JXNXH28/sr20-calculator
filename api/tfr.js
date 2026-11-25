// TFR relay: tfr.faa.gov sends no CORS headers. GET /api/tfr?states=AZ,CA -> {items:[parsed TFRs], skipped:n, at:ISO}
const { verifyJwt, tokenFromRequest } = require('../lib/verify.js');
const { parseTfrXml } = require('../lib/tfrxml.js');
const UA = { 'User-Agent': 'sr20-calculator' };

function parseStates(s) {
  const a = String(s || '').split(',');
  if (a.length < 1 || a.length > 6 || !a.every(x => /^[A-Z]{2}$/.test(x))) return null;
  return [...new Set(a)];
}

async function build(states) {
  const lr = await fetch('https://tfr.faa.gov/tfrapi/exportTfrList', { headers: UA, signal: AbortSignal.timeout(10000) });
  if (!lr.ok) throw new Error('TFR list HTTP ' + lr.status);
  const list = (await lr.json()).filter(x => x && states.includes(x.state) && /^\d+\/\d+$/.test(x.notam_id));
  const items = []; let skipped = 0, i = 0;
  async function worker() {
    while (i < list.length) {
      const t = list[i++];
      try {
        const r = await fetch(`https://tfr.faa.gov/download/detail_${t.notam_id.replace('/', '_')}.xml`, { headers: UA, signal: AbortSignal.timeout(10000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const item = parseTfrXml(await r.text(), { notamId: t.notam_id, state: t.state, description: t.description, type: t.type });
        if (item) items.push(item); else skipped++;
      } catch (e) { skipped++; }
    }
  }
  await Promise.all([1, 2, 3, 4].map(worker));
  items.sort((a, b) => a.id < b.id ? -1 : 1);
  return { items, skipped, at: new Date().toISOString() };
}

async function handler(req, res) {
  if (!(await verifyJwt(tokenFromRequest(req.headers), process.env.SUPABASE_URL))) {
    res.statusCode = 401; res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end('{"error":"unauthenticated"}');
  }
  const states = req.method === 'GET' ? parseStates(new URL(req.url, 'http://localhost').searchParams.get('states')) : null;
  if (!states) { res.statusCode = 400; return res.end('bad request'); }
  try {
    const out = await build(states);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=600');
    res.end(JSON.stringify(out));
  } catch (e) { res.statusCode = 502; res.end('upstream error: ' + e.message); }
}
module.exports = handler;
module.exports.build = build;
module.exports.parseStates = parseStates;
