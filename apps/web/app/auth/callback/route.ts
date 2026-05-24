/**
 * Magic-link callback. Exchanges the ?code= param for a session cookie,
 * then redirects to `next` (defaults to /).
 */
import { NextResponse } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const next = url.searchParams.get('next') ?? '/';

  if (!code) {
    return NextResponse.redirect(new URL('/login', req.url));
  }

  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supaKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supaUrl || !supaKey) {
    return NextResponse.json({ error: 'auth not configured' }, { status: 500 });
  }

  const cookieStore = await cookies();
  const res = NextResponse.redirect(new URL(next, req.url));
  const supabase = createServerClient(supaUrl, supaKey, {
    cookies: {
      get(name: string) { return cookieStore.get(name)?.value; },
      set(name: string, value: string, options: CookieOptions) {
        res.cookies.set({ name, value, ...options });
      },
      remove(name: string, options: CookieOptions) {
        res.cookies.set({ name, value: '', ...options });
      },
    },
  });
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    const errUrl = new URL('/login', req.url);
    errUrl.searchParams.set('error', error.message);
    return NextResponse.redirect(errUrl);
  }
  return res;
}
