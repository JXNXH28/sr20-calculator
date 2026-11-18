// Vercel Routing Middleware (non-Next.js): require a valid Supabase access token (Authorization bearer or sb_at cookie).
// NOTE: needs verifying on the first preview deploy (matcher, x-middleware-next pass-through, CJS import interop).
import verify from './lib/verify.js';

export const config = { matcher: ['/((?!login\\.html|auth\\.js|api/config|favicon\\.ico).*)'] };

export default async function middleware(request) {
  const url = new URL(request.url);
  const token = verify.tokenFromRequest(request.headers);
  const authed = token ? !!(await verify.verifyJwt(token, process.env.SUPABASE_URL)) : false;
  const d = verify.accessDecision(url.pathname, url.search, authed);
  if (d.action === 'next') return new Response(null, { headers: { 'x-middleware-next': '1' } });
  if (d.action === 'redirect') return Response.redirect(new URL(d.location, request.url), 302);
  if (d.action === 'json401') {
    return new Response('{"error":"unauthenticated"}', { status: 401, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  return new Response('unauthenticated', { status: 401, headers: { 'Cache-Control': 'no-store' } });
}
