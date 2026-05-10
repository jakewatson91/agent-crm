/**
 * Read-only: dump all active subscriptions with their filter + threshold + match counts
 * over the last 7d. Used to debug "why aren't signals matching anything?"
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const ws = await sb.from('workspaces').select('id, name')
    .like('name', 'demo · agent-crm%').order('created_at', { ascending: false }).limit(1).single();
  if (ws.error || !ws.data) throw new Error('no demo workspace');
  const WS = ws.data.id as string;
  console.log(`workspace: ${ws.data.name} (${WS.slice(0, 8)}…)\n`);

  const subs = await sb.from('subscriptions')
    .select('id, name, owner_kind, owner_id, semantic_query, structured_filter, threshold, action_on_match, active')
    .eq('workspace_id', WS)
    .order('created_at', { ascending: false });
  console.log(`=== SUBSCRIPTIONS (${subs.data?.length ?? 0}) ===`);
  for (const s of (subs.data ?? []) as Array<any>) {
    const active = s.active ? 'ON ' : 'off';
    console.log(`  [${active}] ${(s.name as string).padEnd(38)} owner=${s.owner_id}`);
    console.log(`    semantic: ${(s.semantic_query as string).slice(0, 100)}`);
    console.log(`    filter: ${JSON.stringify(s.structured_filter)} threshold=${s.threshold} action=${s.action_on_match}`);
  }

  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const matched = await sb.from('events').select('payload')
    .eq('workspace_id', WS).eq('action', 'subscription.matched').gte('ts', since);
  const matchByOwner = new Map<string, number>();
  for (const e of (matched.data ?? []) as Array<{ payload: { subscription_id?: string; owner_id?: string } | null }>) {
    const key = e.payload?.owner_id ?? '?';
    matchByOwner.set(key, (matchByOwner.get(key) ?? 0) + 1);
  }
  console.log('\n=== MATCH COUNTS LAST 7d ===');
  for (const [k, v] of [...matchByOwner.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(40)} ${v}`);
  }
  if (matchByOwner.size === 0) console.log('  (no matches in last 7d)');
}
main().catch((e) => { console.error(e); process.exit(1); });
