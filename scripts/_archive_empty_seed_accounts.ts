/**
 * Archive empty seed accounts: kind='account', created by a seed:* script
 * (events.actor_id LIKE 'seed:%' on the create_account event), AND zero active
 * facts. Sets archived_at — fully reversible (null it out to restore).
 *
 * Deliberately conservative: a seed account WITH facts is kept (it has real
 * data), and an empty account from a real connector is kept (may be awaiting
 * enrichment). Only the intersection — empty AND seed-created — is archived.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = await sb.from('workspaces').select('id, name').like('name', 'demo%').order('created_at', { ascending: false }).limit(1).single();
  if (!ws.data) throw new Error('no workspace');
  const WS = ws.data.id as string;
  console.log(`workspace: ${ws.data.name} (${WS.slice(0, 8)})\n`);

  // All active accounts.
  const accts: Array<{ id: string }> = [];
  for (let from = 0; ; from += 1000) {
    const page = await sb.from('entities').select('id')
      .eq('workspace_id', WS).eq('kind', 'account').is('archived_at', null).range(from, from + 999);
    const rows = (page.data ?? []) as typeof accts;
    accts.push(...rows);
    if (rows.length < 1000) break;
  }
  const ids = accts.map((a) => a.id);
  console.log(`active accounts: ${ids.length}`);

  // Seed-created: actor_id LIKE 'seed:%' on the create_account event.
  const seedSet = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const evs = await sb.from('events').select('target_id, actor_id')
      .eq('workspace_id', WS).eq('action', 'create_account').in('target_id', chunk).like('actor_id', 'seed:%');
    for (const e of (evs.data ?? []) as Array<{ target_id: string }>) seedSet.add(e.target_id);
  }
  console.log(`seed-created accounts: ${seedSet.size}`);

  // Has-facts set.
  const hasFacts = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const f = await sb.from('facts').select('subject_entity').eq('workspace_id', WS).in('subject_entity', chunk).is('supersedes', null);
    for (const r of (f.data ?? []) as Array<{ subject_entity: string }>) hasFacts.add(r.subject_entity);
  }

  const toArchive = ids.filter((id) => seedSet.has(id) && !hasFacts.has(id));
  console.log(`\n→ empty AND seed-created (will archive): ${toArchive.length}`);
  console.log(`  kept: seed-with-facts=${[...seedSet].filter((id) => hasFacts.has(id)).length}, ` +
              `non-seed-empty=${ids.filter((id) => !seedSet.has(id) && !hasFacts.has(id)).length}, ` +
              `non-seed-with-facts=${ids.filter((id) => !seedSet.has(id) && hasFacts.has(id)).length}\n`);

  if (!toArchive.length) { console.log('nothing to archive'); return; }

  const now = new Date().toISOString();
  let archived = 0;
  for (let i = 0; i < toArchive.length; i += 100) {
    const chunk = toArchive.slice(i, i + 100);
    const upd = await sb.from('entities').update({ archived_at: now }).in('id', chunk).is('archived_at', null).select('id');
    if (upd.error) throw upd.error;
    archived += (upd.data ?? []).length;
  }
  console.log(`archived: ${archived}`);

  const after = await sb.from('entities').select('id', { count: 'exact', head: true })
    .eq('workspace_id', WS).eq('kind', 'account').is('archived_at', null);
  console.log(`\npost-state: active accounts now ${after.count}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
