/**
 * Edge middleware that refreshes the Supabase session cookie on every request
 * and gates /workspace/* + protected /api/* routes on session presence.
 *
 * Public routes:
 *   /login, /auth/*, /invite/*, /api/mcp (Bearer-auth'd), /api/inngest (signed).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

const PUBLIC_PATHS = [
  '/login',
  '/auth/',
  '/invite/',
  '/api/auth/',
  '/api/mcp',
  '/api/inngest',
  '/favicon.ico',
];

function isPublic(pathname: string): boolean {
  if (pathname === '/login') return true;
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p));
}

export async function middleware(req: NextRequest) {
  const res = NextResponse.next();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return res; // env missing → let request through; pages will error legibly.

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

  // Refresh session.
  const { data: { user } } = await supabase.auth.getUser();

  const { pathname, search } = req.nextUrl;
  if (isPublic(pathname)) return res;

  if (!user) {
    const next = pathname + search;
    const loginUrl = new URL('/login', req.url);
    loginUrl.searchParams.set('next', next);
    return NextResponse.redirect(loginUrl);
  }

  return res;
}

export const config = {
  // Run on everything except Next internals and static assets.
  matcher: ['/((?!_next/static|_next/image|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};
