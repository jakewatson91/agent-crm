import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { runAgent } from '../inngest/functions/agent_logic.ts';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
async function main() {
  const { data: sub } = await sb.from('subscriptions').select('id, owner_id')
    .eq('workspace_id', WS).eq('agent_behavior', 'enricher').eq('active', true)
    .order('created_at', { ascending: true }).limit(1).single();
  const { data: sigs } = await sb.from('signals').select('id, entity_id, created_at')
    .eq('workspace_id', WS).gte('created_at', '2026-07-14T01:45:00Z')
    .order('created_at', { ascending: true });
  const firstByEntity = new Map<string, string>();
  for (const s of sigs ?? []) if (!firstByEntity.has(s.entity_id)) firstByEntity.set(s.entity_id, s.id);
  for (const [entity_id, signal_id] of firstByEntity) {
    const { data: ent } = await sb.from('entities').select('name').eq('id', entity_id).single();
    console.log(`enriching ${ent?.name} via signal ${signal_id.slice(0, 8)}…`);
    const r = await runAgent(sb, { workspace_id: WS, agent: sub!.owner_id, subscription_id: sub!.id, signal_id });
    console.log(`  → ok=${r.ok} action=${(r as { action?: string }).action} ${JSON.stringify(r).slice(0, 160)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
