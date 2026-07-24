/**
 * Mint a real browser session cookie for local testing.
 *
 * Uses the service-role key to generate a magic-link token for the workspace
 * owner, verifies it with the anon client to get a real signed session, then
 * writes the @supabase/ssr cookie value so curl can hit authed routes. The
 * middleware verifies the token signature remotely, so nothing here is a
 * bypass — it is the same session a browser login produces.
 *
 * Usage: pnpm tsx scripts/_mint_session.ts [email] > /tmp/cookie.txt
 */
import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });
import { createClient } from '@supabase/supabase-js';

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

async function main() {
  const email = process.argv[2] ?? 'jaws.watson@gmail.com';
  const admin = createClient(SUPA_URL, SERVICE, { auth: { persistSession: false } });
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (error) throw error;
  const tokenHash = data.properties?.hashed_token;
  if (!tokenHash) throw new Error('no hashed_token');

  const anon = createClient(SUPA_URL, ANON, { auth: { persistSession: false } });
  const { data: sess, error: verr } = await anon.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' });
  if (verr) throw verr;
  if (!sess.session) throw new Error('no session');

  const ref = new globalThis.URL(SUPA_URL).hostname.split('.')[0];
  const payload = {
    access_token: sess.session.access_token,
    token_type: sess.session.token_type,
    expires_in: sess.session.expires_in,
    expires_at: sess.session.expires_at,
    refresh_token: sess.session.refresh_token,
    user: sess.session.user,
  };
  // @supabase/ssr encodes the session as base64url (not standard base64).
  const value = 'base64-' + Buffer.from(JSON.stringify(payload)).toString('base64url');
  // @supabase/ssr chunks at 3180 chars into sb-<ref>-auth-token.0, .1, ...
  const name = `sb-${ref}-auth-token`;
  const CHUNK = 3180;
  const cookies: string[] = [];
  if (value.length <= CHUNK) cookies.push(`${name}=${value}`);
  else for (let i = 0, n = 0; i < value.length; i += CHUNK, n++) cookies.push(`${name}.${n}=${value.slice(i, i + CHUNK)}`);
  process.stdout.write(cookies.join('; '));
}
main().catch((e) => { console.error(e); process.exit(1); });
