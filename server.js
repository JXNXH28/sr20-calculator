// Serves the calculator and relays a few read-only NOAA/NWS requests (their APIs send no CORS headers).
// Run: node server.js   then open http://localhost:8765
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = process.env.PORT || 8765, ROOT = __dirname;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.pdf': 'application/pdf', '.css': 'text/css' };
const UPSTREAM = {
  aw: { base: 'https://aviationweather.gov/api/data/', ok: /^(airport|metar|taf)$/ },
  nws: { base: 'https://api.weather.gov/', ok: /^(points\/-?\d+(\.\d+)?,-?\d+(\.\d+)?|gridpoints\/[A-Z]{3}\/\d+,\d+)$/ }
};

async function relay(url, res) {
  const m = /^\/api\/(aw|nws)\/(.+)$/.exec(url.pathname);
  const up = m && UPSTREAM[m[1]];
  if (!up || !up.ok.test(m[2])) { res.writeHead(404); return res.end('not allowed'); }
  try {
    const r = await fetch(up.base + m[2] + url.search, { headers: { 'User-Agent': 'sr20-calculator', Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) { res.writeHead(502); res.end('upstream error: ' + e.message); }
}

http.createServer((req, res) => {
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) return relay(url, res);
  const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '') || 'index.html';
  const file = path.join(ROOT, rel === '' || rel.endsWith('/') ? rel + 'index.html' : rel);
  if (!file.startsWith(ROOT + path.sep) || path.basename(file).startsWith('.')) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`SR20 calculator: http://localhost:${PORT}`));
