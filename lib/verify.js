// Shared Supabase JWT verifier + access rules. CommonJS, zero deps, WebCrypto only (Vercel Edge and Node 24).
'use strict';

const PUBLIC_PATHS = ['/login.html', '/auth.js', '/api/config', '/api/config.js', '/favicon.ico'];
const JWKS_TTL = 10 * 60 * 1000, REFETCH_MIN = 60 * 1000, SKEW = 30;
const cache = new Map(); // url -> { keys: Map(kid -> jwk), at, tried }

function b64u(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64uJson = (s) => JSON.parse(new TextDecoder().decode(b64u(s)));

async function loadKeys(base) {
  const r = await fetch(base + '/auth/v1/.well-known/jwks.json', { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error('jwks ' + r.status);
  const j = await r.json();
  const keys = new Map();
  for (const k of (j.keys || [])) if (k && k.kid) keys.set(k.kid, k);
  return keys;
}

async function getKey(base, kid) {
  const now = Date.now();
  let c = cache.get(base);
  if (!c || now - c.at > JWKS_TTL) {
    try { c = { keys: await loadKeys(base), at: now, tried: now }; cache.set(base, c); }
    catch (e) { if (!c) return null; }
  }
  if (!c.keys.has(kid) && now - c.tried > REFETCH_MIN) {
    c.tried = now;
    try { c.keys = await loadKeys(base); c.at = now; } catch (e) { /* keep old */ }
  }
  return c.keys.get(kid) || null;
}

async function verifyJwt(token, supabaseUrl) {
  try {
    if (typeof token !== 'string' || !supabaseUrl) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const header = b64uJson(parts[0]), payload = b64uJson(parts[1]);
    if (!header || !payload || typeof header.kid !== 'string') return null;
    const base = String(supabaseUrl).replace(/\/+$/, '');
    const jwk = await getKey(base, header.kid);
    if (!jwk || (jwk.alg && jwk.alg !== header.alg)) return null;
    let importAlg, verifyAlg;
    if (header.alg === 'ES256' && jwk.kty === 'EC') {
      importAlg = { name: 'ECDSA', namedCurve: 'P-256' }; verifyAlg = { name: 'ECDSA', hash: 'SHA-256' };
    } else if (header.alg === 'RS256' && jwk.kty === 'RSA') {
      importAlg = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }; verifyAlg = { name: 'RSASSA-PKCS1-v1_5' };
    } else return null;
    const { kid, alg, use, key_ops, ext, ...pub } = jwk; // eslint-disable-line no-unused-vars
    const key = await crypto.subtle.importKey('jwk', pub, importAlg, false, ['verify']);
    const ok = await crypto.subtle.verify(verifyAlg, key, b64u(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
    if (!ok) return null;
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp + SKEW < now) return null;
    if (typeof payload.nbf === 'number' && payload.nbf - SKEW > now) return null;
    if (payload.iss !== base + '/auth/v1') return null;
    const aud = payload.aud;
    if (!(aud === 'authenticated' || (Array.isArray(aud) && aud.includes('authenticated')))) return null;
    return payload;
  } catch (e) { return null; }
}

function tokenFromRequest(headers) {
  const get = (n) => !headers ? null : typeof headers.get === 'function' ? headers.get(n) : headers[n];
  const a = get('authorization');
  if (typeof a === 'string') { const m = /^Bearer\s+(\S+)$/i.exec(a.trim()); if (m) return m[1]; }
  const c = get('cookie');
  if (typeof c === 'string') {
    for (const part of c.split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === 'sb_at') return part.slice(i + 1).trim() || null;
    }
  }
  return null;
}

function isPublicPath(pathname) { return PUBLIC_PATHS.includes(pathname); }

// One decision for middleware.js and server.js.
// -> { action: 'next' } | { action: 'json401' } | { action: 'redirect', location } | { action: 'deny' }
function accessDecision(pathname, search, authed) {
  if (authed || isPublicPath(pathname)) return { action: 'next' };
  if (pathname.startsWith('/api/')) return { action: 'json401' };
  if (pathname === '/' || pathname.endsWith('.html')) {
    return { action: 'redirect', location: '/login.html?next=' + encodeURIComponent(pathname + (search || '')) };
  }
  return { action: 'deny' };
}

module.exports = { verifyJwt, tokenFromRequest, isPublicPath, accessDecision, PUBLIC_PATHS };
