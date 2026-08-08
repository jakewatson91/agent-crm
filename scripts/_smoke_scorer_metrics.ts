import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { scoreEntity } from '@agent-crm/tools';

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data: ws } = await sb.from('workspaces').select('id').ilike('name', 'Sudden');
  const wsId = (ws as Array<{ id: string }>)[0]!.id;
  const { data: f } = await sb.from('facts').select('subject_entity').eq('workspace_id', wsId).eq('predicate', 'icp_fit').limit(1);
  const entId = (f as Array<{ subject_entity: string }>)[0]!.subject_entity;

  const t0 = new Date().toISOString();
  const score = await scoreEntity(sb, wsId, entId);
  console.log('scoreEntity ->', score ? `total=${score.total}` : 'null');

  const { data: ev } = await sb.from('events').select('action, payload, created_at')
    .eq('workspace_id', wsId).in('action', ['agent_run_metrics', 'agent_llm_failed'])
    .gte('created_at', t0).order('created_at', { ascending: false });
  console.log('events written since call:', JSON.stringify(ev, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
