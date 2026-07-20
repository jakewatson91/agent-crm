import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { scoreAndAssert } from '@agent-crm/tools';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

async function main() {
  const { data: ws } = await sb.from('workspaces').select('updated_at').eq('id', WS).single();
  const { data: stale } = await sb.from('facts')
    .select('subject_entity, observed_at')
    .eq('workspace_id', WS).eq('predicate', 'icp_fit')
    .is('supersedes', null)
    .lt('observed_at', ws!.updated_at as string)
    .order('observed_at', { ascending: true })
    .limit(3);
  console.log('3 oldest stale candidates (same as cron picks):');
  for (const r of stale ?? []) console.log(' ', r.subject_entity, r.observed_at);

  const target = stale![0].subject_entity;
  const { data: ent } = await sb.from('entities').select('name').eq('id', target).single();
  console.log(`\nRunning scoreAndAssert on "${ent?.name}" (${target}) ...`);
  const actor = { workspace_id: WS, actor_kind: 'system' as const, actor_id: 'repro_rescore_local' };
  try {
    const score = await scoreAndAssert(sb, actor, target);
    console.log('result:', score === null ? 'NULL (gated/prefiltered — nothing written)' : JSON.stringify({ icp_total: score.icp_total, breakdown: score.breakdown, reasoning: score.reasoning?.slice(0, 200) }));
  } catch (e) {
    console.error('THREW:', e instanceof Error ? e.message : e);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
