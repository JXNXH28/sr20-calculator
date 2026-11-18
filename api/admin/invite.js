// Admin-only: invite a user by email (Supabase GoTrue, service role) and optionally grant initial tokens.
// POST /api/admin/invite  {email, name?, tokens?}  with the caller's Supabase access token.
const { verifyJwt, tokenFromRequest } = require('../../lib/verify.js');

const MAX_BODY = 10 * 1024;

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') return req.body.length > MAX_BODY ? null : req.body;
    if (Buffer.isBuffer(req.body)) return req.body.length > MAX_BODY ? null : req.body.toString('utf8');
    const s = JSON.stringify(req.body);
    return s.length > MAX_BODY ? null : s;
  }
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > MAX_BODY) return null; chunks.push(c); }
  return Buffer.concat(chunks).toString('utf8');
}

async function text(r) { try { return await r.text(); } catch (e) { return ''; } }
function parse(t) { try { return t ? JSON.parse(t) : null; } catch (e) { return null; } }

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader && res.setHeader('Allow', 'POST'); return send(res, 405, { error: 'method_not_allowed' }); }
  const base = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const anon = process.env.SUPABASE_ANON_KEY, svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !anon || !svc) return send(res, 500, { error: 'not_configured' });

  const token = tokenFromRequest(req.headers);
  if (!(await verifyJwt(token, base))) return send(res, 401, { error: 'unauthenticated' });

  // Caller must be admin: ask PostgREST as the caller.
  let isAdmin = false;
  try {
    const r = await fetch(base + '/rest/v1/rpc/is_admin', {
      method: 'POST',
      headers: { apikey: anon, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: '{}', signal: AbortSignal.timeout(10000)
    });
    isAdmin = r.ok && parse(await text(r)) === true;
  } catch (e) { return send(res, 502, { error: 'upstream_error', message: 'Could not verify admin role' }); }
  if (!isAdmin) return send(res, 403, { error: 'forbidden' });

  const raw = await readBody(req);
  if (raw === null) return send(res, 413, { error: 'body_too_large' });
  const b = parse(raw);
  if (!b || typeof b !== 'object' || Array.isArray(b)) return send(res, 400, { error: 'bad_request', message: 'JSON body required' });

  const email = typeof b.email === 'string' ? b.email.trim() : '';
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send(res, 400, { error: 'invalid_email' });
  const name = b.name === undefined || b.name === null ? '' : b.name;
  if (typeof name !== 'string' || name.trim().length > 100) return send(res, 400, { error: 'invalid_name' });
  const tokens = b.tokens === undefined || b.tokens === null || b.tokens === '' ? 0 : b.tokens;
  if (!Number.isInteger(tokens) || tokens < 0 || tokens > 1000) return send(res, 400, { error: 'invalid_tokens' });

  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  let origin = 'http://localhost:8765';
  if ((proto === 'http' || proto === 'https' || !proto) && /^[A-Za-z0-9.\-:\[\]]+$/.test(host)) origin = (proto || 'http') + '://' + host;

  let id;
  try {
    const r = await fetch(base + '/auth/v1/invite?redirect_to=' + encodeURIComponent(origin + '/login.html'), {
      method: 'POST',
      headers: { apikey: svc, Authorization: 'Bearer ' + svc, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, data: name.trim() ? { name: name.trim() } : {} }),
      signal: AbortSignal.timeout(10000)
    });
    const j = parse(await text(r));
    if (!r.ok) {
      const m = String((j && (j.msg || j.message || j.error_description || j.error)) || '');
      if (r.status === 422 || r.status === 409 || /already|registered|exists/i.test(m) || (j && j.error_code === 'email_exists'))
        return send(res, 409, { error: 'already_registered' });
      return send(res, 502, { error: 'invite_failed', message: m.split(svc).join('***') || ('Invite failed (' + r.status + ')') });
    }
    id = (j && (j.id || (j.user && j.user.id))) || null;
  } catch (e) { return send(res, 502, { error: 'invite_failed', message: 'Auth service unreachable' }); }
  if (!id) return send(res, 502, { error: 'invite_failed', message: 'Invite sent but no user id returned; grant tokens manually' });

  if (tokens > 0) {
    try {
      const r = await fetch(base + '/rest/v1/rpc/admin_adjust_tokens', {
        method: 'POST',
        headers: { apikey: anon, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_user: id, p_delta: tokens, p_note: 'initial grant' }),
        signal: AbortSignal.timeout(10000)
      });
      if (!r.ok) {
        const j = parse(await text(r));
        return send(res, 502, { error: 'grant_failed', id, message: 'Invite sent, but granting tokens failed: ' + String((j && j.message) || r.status) });
      }
    } catch (e) { return send(res, 502, { error: 'grant_failed', id, message: 'Invite sent, but granting tokens failed' }); }
  }
  return send(res, 200, { id, email, tokens });
};
