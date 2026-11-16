// Local dev server: serves the calculator and the same /api/aw relay that Vercel runs (api/aw/[ep].js).
// Run: node server.js   then open http://localhost:8765
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = process.env.PORT || 8765, ROOT = __dirname;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.pdf': 'application/pdf', '.css': 'text/css' };
const relay = require('./api/aw/[ep].js');

http.createServer((req, res) => {
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/aw/')) return relay(req, res);
  const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '') || 'index.html';
  const file = path.join(ROOT, rel === '' || rel.endsWith('/') ? rel + 'index.html' : rel);
  if (!file.startsWith(ROOT + path.sep) || path.basename(file).startsWith('.')) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`SR20 calculator: http://localhost:${PORT}`));
