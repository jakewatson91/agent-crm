/**
 * Delete a workspace and everything scoped to it. Every workspace_id FK has
 * `on delete cascade`, but two things stand in the way of a single `delete
 * from workspaces where id=...`:
 *   1. It times out once the cascade has to remove tens of thousands of rows
 *      in one transaction (confirmed live: PG 57014, on a workspace with
 *      ~18k facts) — so delete the biggest tables in small batches first.
 *   2. `events` has DELETE revoked from every role including service_role, to
 *      keep the append-only log honest — even a cascade can't remove it
 *      directly. The sanctioned path is `prune_events()`, a SECURITY DEFINER
 *      RPC that whitelists which actions to remove and refuses to touch any
 *      event a fact still points to. Since facts are deleted first below, by
 *      the time we call it every event in this workspace is fair game.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

async function batchDelete(table: string, workspaceId: string, batchSize = 500) {
  let total = 0;
  for (;;) {
    const { data, error: selErr } = await sb.from(table).select('id').eq('workspace_id', workspaceId).limit(batchSize);
    if (selErr) throw new Error(`${table} select failed: ${selErr.message}`);
    const ids = (data ?? []).map((r: { id: string }) => r.id);
    if (!ids.length) break;
    const { error: delErr } = await sb.from(table).delete().in('id', ids);
    if (delErr) throw new Error(`${table} delete failed: ${delErr.message}`);
    total += ids.length;
  }
  if (total) console.log(`  ${table}: -${total}`);
  return total;
}

async function distinctActions(workspaceId: string): Promise<string[]> {
  // A plain LIMIT sample isn't reliable for "every distinct action" on a
  // large table (missed rarer action types on the first pass here) — page
  // through everything and dedupe properly.
  const seen = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('events').select('action').eq('workspace_id', workspaceId).range(from, from + 999);
    if (error) throw new Error(`events action scan failed: ${error.message}`);
    for (const r of (data ?? []) as Array<{ action: string }>) seen.add(r.action);
    if (!data || data.length < 1000) break;
  }
  return [...seen];
}

async function pruneAllEvents(workspaceId: string) {
  const actions = await distinctActions(workspaceId);
  if (!actions.length) return;
  console.log(`  events: found action types [${actions.join(', ')}]`);

  const oldest = await sb.from('events').select('created_at').eq('workspace_id', workspaceId)
    .order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (!oldest.data) return;

  // prune_events runs one unbounded DELETE with no internal batching — for a
  // workspace with tens of thousands of events that times out in one call.
  // Walk forward in small time windows instead, so each call only has to
  // delete a few hundred rows.
  const WINDOW_MS = 2 * 60_000;
  let cursor = new Date(oldest.data.created_at).getTime();
  const end = Date.now() + 60_000; // safely past "now"
  let total = 0;
  while (cursor < end) {
    cursor += WINDOW_MS;
    const cutoff = new Date(cursor).toISOString();
    const { data: deleted, error } = await sb.rpc('prune_events', {
      p_workspace_id: workspaceId, p_actions: actions, p_cutoff: cutoff,
    });
    if (error) throw new Error(`prune_events failed at cutoff ${cutoff}: ${error.message}`);
    total += deleted ?? 0;
  }
  console.log(`  events: -${total} (actions: ${actions.join(', ')})`);
}

async function main() {
  const WS = process.argv[2];
  if (!WS) { console.error('usage: tsx scripts/_delete_workspace.ts <workspace_id>'); process.exit(1); }

  const before = await sb.from('workspaces').select('id, name').eq('id', WS).maybeSingle();
  if (!before.data) { console.log('workspace not found, nothing to delete'); return; }
  console.log(`deleting workspace: ${before.data.name} (${WS})`);

  for (const table of ['facts', 'signals', 'entities', 'channels', 'subscriptions', 'sources', 'conversations']) {
    await batchDelete(table, WS);
  }
  await pruneAllEvents(WS);

  console.log('deleting workspace row...');
  const { error } = await sb.from('workspaces').delete().eq('id', WS);
  if (error) { console.error(JSON.stringify(error, null, 2)); process.exit(1); }

  const after = await sb.from('workspaces').select('id').eq('id', WS).maybeSingle();
  console.log('deleted. still exists?', !!after.data);
}
main().catch((e) => { console.error(e); process.exit(1); });
