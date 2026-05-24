/**
 * Dry-run the L2 source curator on the most-recent workspace. Prints the
 * candidate set, the LLM decisions, and what WOULD be applied. No DB writes.
 *
 * Pass --apply to actually mutate (respects the curator's own rate limits).
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { curateWorkspaceSources } from '@agent-crm/tools';

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false }});
  const apply = process.argv.includes('--apply');
  const ws = (await sb.from('workspaces').select('id,name').order('created_at',{ascending:false}).limit(1).single()).data!;
  console.log(`workspace: ${ws.name}  apply=${apply}`);

  const t0 = Date.now();
  const result = await curateWorkspaceSources(sb, ws.id, { apply });
  const ms = Date.now() - t0;

  console.log(`\ncandidates evaluated: ${result.decisions.length}  applied: ${result.applied}  ms=${ms}`);
  if (result.skipped_cooldown.length) {
    console.log(`skipped (cooldown): ${result.skipped_cooldown.join(', ')}`);
  }
  for (const d of result.decisions) {
    console.log(`\n--- ${d.source_name} → ${d.action}`);
    console.log(`    reasoning: ${d.reasoning}`);
    console.log(`    metrics: sig7=${d.metrics_snapshot.signals_7d} sig14=${d.metrics_snapshot.signals_14d} fire7=${d.metrics_snapshot.agent_fire_rate_7d.toFixed(2)} yield7=${d.metrics_snapshot.fact_yield_7d.toFixed(2)}`);
    if (d.new_query) console.log(`    new_query: ${d.new_query}`);
    if (d.new_subscription_semantic) console.log(`    new_sub:   ${d.new_subscription_semantic}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
