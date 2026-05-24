/**
 * One-off: assign ownership of all workspaces that currently have no members
 * to the given user. Useful right after introducing auth on a single-tenant
 * deployment — existing workspaces have no workspace_members rows, so the
 * signed-in user can't see them without this.
 *
 * Usage:
 *   pnpm exec tsx scripts/bootstrap_owner.ts <email>
 *
 * Requires .env.local with SUPABASE_SERVICE_ROLE_KEY.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

async function main() {
  const email = process.argv[2];
  if (!email) throw new Error('usage: bootstrap_owner.ts <email>');

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('missing Supabase env vars');

  const sb = createClient(url, key, { auth: { persistSession: false } });

  // Find the user by email.
  const { data: users } = await sb.auth.admin.listUsers({ perPage: 200 });
  const user = (users?.users ?? []).find((u) => (u.email ?? '').toLowerCase() === email.toLowerCase());
  if (!user) throw new Error(`no auth user with email ${email}`);
  console.log(`found user ${user.id} (${user.email})`);

  // Workspaces with no members.
  const { data: workspaces } = await sb.from('workspaces').select('id, name');
  const { data: existingMemberships } = await sb.from('workspace_members')
    .select('workspace_id').eq('user_id', user.id);
  const haveAccess = new Set((existingMemberships ?? []).map((m) => m.workspace_id as string));

  const toClaim = (workspaces ?? []).filter((w) => !haveAccess.has(w.id as string));
  if (toClaim.length === 0) {
    console.log('nothing to claim — user is already a member of every workspace');
    return;
  }

  for (const ws of toClaim) {
    const { error } = await sb.from('workspace_members').insert({
      workspace_id: ws.id, user_id: user.id, role: 'owner',
    });
    if (error) console.error(`✗ ${ws.id} ${ws.name}: ${error.message}`);
    else console.log(`✓ ${ws.id} ${ws.name} → owner`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
