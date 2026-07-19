/**
 * Edge middleware that gates /workspace/* + protected /api/* routes.
 *
 * This IS the auth boundary: server pages read with the service-role client
 * (no RLS) and page-side getUser() is a local cookie decode, so nothing after
 * middleware re-verifies the token's signature. That rules out a decode-only
 * fast path — a hand-built cookie with a future exp would sail through.
 *
 * Instead: verify-once-then-cache. The first request with a given access
 * token pays the remote auth.getUser() call (signature check + refresh); the
 * exact token string is then cached in-process for up to 5 minutes (same
 * staleness budget as the role cache in _lib/auth.ts), and requests
 * presenting a cached token skip the network round-trip (~100-150ms/request).
 * A forged token is never cached, so it always hits the remote check and
 * bounces.
 *
 * When a cached entry goes stale (5 min - 1 h old), the request is let
 * through and the re-verify runs in the background (event.waitUntil), so a
 * user coming back after coffee doesn't pay a blocking ~0.5s check (measured
 * 0.78s vs 0.25s on the feed). A session revoked elsewhere gets at most one
 * page render before the background check evicts it — the blocking variant
 * already allowed that for a full 5 minutes, so this trades nothing real.
 * Tokens near their hard expiry always take the blocking path, which is also
 * what refreshes the session cookie.
 *
 * Public routes:
 *   /login, /auth/*, /invite/*, /api/mcp (Bearer-auth'd), /api/inngest (signed),
 *   /api/health (keepalive pings — must return 200, not 307-redirect to login).
 */
import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

const PUBLIC_PATHS = [
  '/login',
  '/auth/',
  '/invite/',
  '/api/auth/',
  '/api/mcp',
  '/api/inngest',
  '/api/health',
  '/favicon.ico',
];

function isPublic(pathname: string): boolean {
  if (pathname === '/login') return true;
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p));
}

// access token string → unix seconds until which it counts as fresh.
// Fresh: pass with no remote call. Stale (up to STALE_FOR_S past fresh):
// pass, but re-verify in the background. Older / absent: blocking verify.
const VERIFIED_TTL_S = 300;
const STALE_FOR_S = 3600;
const verifiedTokens = new Map<string, number>();

function pruneVerified(now: number) {
  if (verifiedTokens.size < 2000) return;
  for (const [jwt, until] of verifiedTokens) {
    if (until + STALE_FOR_S <= now) verifiedTokens.delete(jwt);
  }
}

// Background re-verify for a stale-cached token: refresh the cache entry on
// success, evict on rejection so the next request takes the blocking path.
// Network errors keep the stale entry (fail toward re-checking next time,
// not toward logging the user out on a blip).
async function reverify(jwt: string, exp: number, url: string, key: string) {
  try {
    const sb = createClient(url, key, { auth: { persistSession: false } });
    const { data: { user }, error } = await sb.auth.getUser(jwt);
    const now = Math.floor(Date.now() / 1000);
    if (user) verifiedTokens.set(jwt, Math.min(exp, now + VERIFIED_TTL_S));
    else if (error && error.status !== undefined && error.status < 500) verifiedTokens.delete(jwt);
  } catch {
    /* transient network failure — keep the stale entry */
  }
}

// Reassemble the @supabase/ssr auth cookie (possibly chunked into `.0`, `.1`, …)
// and return the raw access token + its decoded (NOT verified) expiry.
function readAccessToken(req: NextRequest, projectRef: string): { jwt: string; exp: number } | null {
  const base = `sb-${projectRef}-auth-token`;
  let raw = req.cookies.get(base)?.value;
  if (!raw) {
    const chunks: string[] = [];
    for (let i = 0; ; i++) {
      const c = req.cookies.get(`${base}.${i}`)?.value;
      if (c === undefined) break;
      chunks.push(c);
    }
    if (!chunks.length) return null;
    raw = chunks.join('');
  }
  try {
    const json = raw.startsWith('base64-')
      ? atob(raw.slice('base64-'.length).replace(/-/g, '+').replace(/_/g, '/'))
      : decodeURIComponent(raw);
    const session = JSON.parse(json) as { access_token?: string };
    const jwt = session.access_token;
    if (!jwt) return null;
    const payload = jwt.split('.')[1];
    if (!payload) return null;
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
    if (typeof claims.exp !== 'number') return null;
    return { jwt, exp: claims.exp };
  } catch {
    return null;
  }
}

export async function middleware(req: NextRequest, event: NextFetchEvent) {
  const res = NextResponse.next();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return res; // env missing → let request through; pages will error legibly.

  const { pathname, search } = req.nextUrl;
  if (isPublic(pathname)) return res;

  // Fast path: this exact token already passed a remote signature check and
  // isn't near expiry. Fresh entry → pass outright; stale entry → pass now,
  // re-verify off the request path.
  const projectRef = new URL(url).hostname.split('.')[0] ?? '';
  const auth = readAccessToken(req, projectRef);
  const now = Math.floor(Date.now() / 1000);
  if (auth && auth.exp > now + 60) {
    const until = verifiedTokens.get(auth.jwt);
    if (until !== undefined && until > now) return res;
    if (until !== undefined && until + STALE_FOR_S > now) {
      event.waitUntil(reverify(auth.jwt, auth.exp, url, key));
      return res;
    }
  }

  // Slow path: unseen/expired/near-expiry token — full remote check, which
  // also refreshes the session cookie when needed.
  const supabase = createServerClient(url, key, {
    cookies: {
      get(name: string) { return req.cookies.get(name)?.value; },
      set(name: string, value: string, options: CookieOptions) {
        res.cookies.set({ name, value, ...options });
      },
      remove(name: string, options: CookieOptions) {
        res.cookies.set({ name, value: '', ...options });
      },
    },
  });
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    const next = pathname + search;
    const loginUrl = new URL('/login', req.url);
    loginUrl.searchParams.set('next', next);
    return NextResponse.redirect(loginUrl);
  }

  if (auth) {
    pruneVerified(now);
    verifiedTokens.set(auth.jwt, Math.min(auth.exp, now + VERIFIED_TTL_S));
  }

  return res;
}

export const config = {
  // Run on everything except Next internals and static assets.
  matcher: ['/((?!_next/static|_next/image|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};
