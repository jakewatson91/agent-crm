import { createServerClient } from '@agent-crm/db';

(async () => {
  const s = createServerClient();
  const WS = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
  const since = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const ev = await s.from('events').select('actor_id, actor_kind, created_at')
    .eq('workspace_id', WS).eq('action', 'create_signal').gte('created_at', since)
    .order('created_at', { ascending: false }).limit(1000);
  const by: Record<string, number> = {}; let max = '';
  for (const e of (ev.data ?? []) as Array<{ actor_id: string; created_at: string }>) {
    by[e.actor_id] = (by[e.actor_id] ?? 0) + 1; if (e.created_at > max) max = e.created_at;
  }
  console.log('create_signal events last 20min by actor:', JSON.stringify(by, null, 2));
  console.log('most recent create_signal at:', max || '(none)', ' now:', new Date().toISOString());

  const sig = await s.from('signals').select('structured_tags, observed_at, entity_id')
    .eq('workspace_id', WS).eq('type', 'research_result').gte('observed_at', since)
    .order('observed_at', { ascending: false }).limit(8);
  console.log('\nsample recent research_result tags:');
  for (const r of (sig.data ?? []) as Array<{ structured_tags: any; observed_at: string }>) {
    console.log('  ', r.observed_at, JSON.stringify(r.structured_tags));
  }
})().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
