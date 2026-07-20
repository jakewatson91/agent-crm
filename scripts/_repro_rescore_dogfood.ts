import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { scoreAndAssert } from '@agent-crm/tools';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
async function main() {
  const { data: e } = await sb.from('entities').select('id, name').eq('workspace_id', WS).eq('name', 'CTGT').limit(1).single();
  console.log(`scoreAndAssert on dogfood "${e!.name}" (${e!.id})`);
  try {
    const score = await scoreAndAssert(sb, { workspace_id: WS, actor_kind: 'system', actor_id: 'repro_rescore_local' }, e!.id);
    console.log('result:', score === null ? 'NULL — nothing written' : `scored ${score.icp_total.toFixed(2)} (rrf_prefilter=${(score.breakdown as Record<string, number>).rrf_prefilter?.toFixed(3)})`);
  } catch (err) {
    console.error('THREW:', err instanceof Error ? err.message : err);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
