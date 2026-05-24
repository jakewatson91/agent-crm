/**
 * Cookie-aware Supabase clients for the App Router.
 *
 * Two flavors:
 * - createUserServerClient: respects the user's session cookie and RLS. Use in
 *   pages, layouts, and route handlers that act on behalf of a signed-in user.
 * - createServiceClient (re-export): bypasses RLS via service_role. Use for
 *   bootstrap operations (e.g. inserting the first workspace_members row on
 *   workspace create) and for /api/mcp once the Bearer key has authenticated.
 */
import { cookies } from 'next/headers';
import { createServerClient as createSsrClient, type CookieOptions } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createServerClient as createServiceClient } from '@agent-crm/db';

export { createServiceClient };

export async function createUserServerClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Missing Supabase env vars');
  return createSsrClient(url, key, {
    cookies: {
      get(name: string) {
        return cookieStore.get(name)?.value;
      },
      set(name: string, value: string, options: CookieOptions) {
        try { cookieStore.set({ name, value, ...options }); } catch {
          // Called from a Server Component where set isn't allowed.
          // Middleware refreshes the session, so this is fine.
        }
      },
      remove(name: string, options: CookieOptions) {
        try { cookieStore.set({ name, value: '', ...options }); } catch { /* see above */ }
      },
    },
  });
}
