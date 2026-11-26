// Public runtime config for the browser: window.SB_CONFIG = {url, anonKey, charts}. The anon key is public by design.
module.exports = async function handler(req, res) {
  const cfg = { url: process.env.SUPABASE_URL || '', anonKey: process.env.SUPABASE_ANON_KEY || '', charts: process.env.CHARTS_PUBLIC_URL || '' };
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end('window.SB_CONFIG=' + JSON.stringify(cfg).replace(/</g, '\\u003c') + ';');
};
