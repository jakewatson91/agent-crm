/**
 * Magic-link callback. Establishes a session cookie, then redirects to `next`
 * (defaults to /). Handles every way Supabase can hand control back:
 *   - ?error / ?error_description  → link expired/used/denied; forward to /login so it's visible.
 *   - ?code                        → PKCE flow (default). exchangeCodeForSession.
 *   - ?token_hash & ?type          → verifyOtp flow (if the email template is switched to it).
 * Any failure forwards the real message to /login?error=... instead of bouncing silently.
 */
import { NextResponse } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import type { EmailOtpType } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

export const runtime = 'nodejs';

function backToLogin(req: Request, next: string, error?: string) {
  const u = new URL('/login', req.url);
  if (next && next !== '/') u.searchParams.set('next', next);
  if (error) u.searchParams.set('error', error);
  return NextResponse.redirect(u);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const params = url.searchParams;
  const next = params.get('next') ?? '/';

  // Supabase handed back an error (expired/already-used link, access denied, etc.).
  // Forward it so the login page can show *why* instead of looping silently.
  const handedBackError = params.get('error_description') || params.get('error');
  if (handedBackError) return backToLogin(req, next, handedBackError);

  const code = params.get('code');
  const tokenHash = params.get('token_hash');
  const type = params.get('type');

  if (!code && !tokenHash) {
    return backToLogin(req, next, 'Sign-in link was missing its code. Request a fresh link.');
  }

  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supaKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supaUrl || !supaKey) {
    return NextResponse.json({ error: 'auth not configured' }, { status: 500 });
  }

  const cookieStore = await cookies();
  const res = NextResponse.redirect(new URL(next, req.url));
  // getAll/setAll is the current @supabase/ssr interface; the deprecated
  // get/set/remove trio is the documented cause of "random logout" cookie bugs.
  const supabase = createServerClient(supaUrl, supaKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        cookiesToSet.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
      },
    },
  });

  const { error } = code
    ? await supabase.auth.exchangeCodeForSession(code)
    : await supabase.auth.verifyOtp({ type: (type as EmailOtpType) ?? 'email', token_hash: tokenHash! });

  if (error) return backToLogin(req, next, error.message);
  return res;
}
