// Local dev server: serves the calculator and the same /api/aw relay that Vercel runs (api/aw/[ep].js).
// Same access rules as middleware.js (lib/verify.js). Needs SUPABASE_URL and SUPABASE_ANON_KEY.
// Run: SUPABASE_URL=… SUPABASE_ANON_KEY=… node server.js   then open http://localhost:8765
const http = require('http'), fs = require('fs'), path = require('path');
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.error('SUPABASE_URL and SUPABASE_ANON_KEY must be set (login is required; there is no open mode).');
  process.exit(1);
}
const PORT = process.env.PORT || 8765, ROOT = __dirname;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.pdf': 'application/pdf', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' };
const relay = require('./api/aw/[ep].js');
const config = require('./api/config.js');
const invite = require('./api/admin/invite.js');
const { verifyJwt, tokenFromRequest, accessDecision } = require('./lib/verify.js');

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const isInvite = req.method === 'POST' && url.pathname === '/api/admin/invite';
  if (req.method !== 'GET' && req.method !== 'HEAD' && !isInvite) { res.writeHead(405); return res.end(); }
  const token = tokenFromRequest(req.headers);
  const authed = token ? !!(await verifyJwt(token, process.env.SUPABASE_URL)) : false;
  const d = accessDecision(url.pathname, url.search, authed);
  if (d.action === 'redirect') { res.writeHead(302, { Location: d.location }); return res.end(); }
  if (d.action === 'json401') { res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' }); return res.end('{"error":"unauthenticated"}'); }
  if (d.action === 'deny') { res.writeHead(401); return res.end('unauthenticated'); }
  if (isInvite) return invite(req, res);
  if (url.pathname === '/api/config' || url.pathname === '/api/config.js') return config(req, res);
  if (url.pathname.startsWith('/api/aw/')) return relay(req, res);
  let rel;
  try { rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '') || 'index.html'; } catch (e) { res.writeHead(400); return res.end(); }
  const file = path.join(ROOT, rel === '' || rel.endsWith('/') ? rel + 'index.html' : rel);
  if (!file.startsWith(ROOT + path.sep) || path.basename(file).startsWith('.')) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`SR20 calculator: http://localhost:${PORT}`));
