/**
 * One-shot fix for three signal-coverage issues found during sweep on 2026-05-17:
 *
 *   1. HN source running hourly is overkill for a demo workspace — switch to 6h
 *      to match exa/web cadence and cut signal-source concentration.
 *   2. `watch_x_posts_icp_companies` subscription filters on `signal_source=github`
 *      but its semantic is about X (Twitter). No X connector exists; drop the
 *      filter so the embedding can at least match anything ICP-shaped.
 *   3. `stealth_mode_yc_startup_launches` filters on `signal_source=yc_directory`
 *      but the YC connector emits `yc`. Fix the value.
 *   4. Add a catch-all enricher subscription with no structured filter so the
 *      ~75% of signals (HN today) that don't match any specific subscription
 *      still get pulled into the enrichment path. The enricher itself decides
 *      whether to extract facts.
 *
 * Re-runnable.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { callTool } from '@agent-crm/tools';

const CATCHALL_OWNER = 'claims_catchall_enricher';
const CATCHALL_NAME = 'catchall_enricher';
const CATCHALL_SEMANTIC =
  'any incoming signal that mentions a company, person, hiring move, product launch, funding event, tooling decision, or pain point worth recording as a structured fact';
const CATCHALL_THRESHOLD = 0.15;

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const ws = (await sb.from('workspaces').select('id,name').order('created_at', { ascending: false }).limit(1).single()).data!;
  console.log(`workspace: ${ws.name} (${ws.id})\n`);

  // 1. HN cron → 6h
  const hn = await sb.from('sources').update({ schedule_cron: '0 */6 * * *' })
    .eq('workspace_id', ws.id).eq('connector_type', 'hn').eq('active', true)
    .select('name, schedule_cron');
  if (hn.error) console.log('hn update error:', hn.error.message);
  else console.log(`[1] HN cron → 6h: ${hn.data?.length ?? 0} source(s)`);
  for (const r of hn.data ?? []) console.log(`    - ${(r as any).name} cron=${(r as any).schedule_cron}`);

  // 2. watch_x_posts_icp_companies → drop the bogus signal_source=github filter
  const x = await sb.from('subscriptions').update({ structured_filter: {} })
    .eq('workspace_id', ws.id).eq('owner_id', 'claims_icp_companies')
    .select('name, structured_filter');
  if (x.error) console.log('x update error:', x.error.message);
  else console.log(`\n[2] watch_x_posts_icp_companies filter cleared: ${x.data?.length ?? 0} sub(s)`);
  for (const r of x.data ?? []) console.log(`    - ${(r as any).name} filter=${JSON.stringify((r as any).structured_filter)}`);

  // 3. stealth_mode_yc_startup_launches → signal_source: 'yc'
  const yc = await sb.from('subscriptions').update({ structured_filter: { signal_source: 'yc' } })
    .eq('workspace_id', ws.id).eq('owner_id', 'claims_stealth_mode_yc_startup')
    .select('name, structured_filter');
  if (yc.error) console.log('yc update error:', yc.error.message);
  else console.log(`\n[3] stealth_mode_yc_startup_launches filter fixed: ${yc.data?.length ?? 0} sub(s)`);
  for (const r of yc.data ?? []) console.log(`    - ${(r as any).name} filter=${JSON.stringify((r as any).structured_filter)}`);

  // 4. catch-all enricher (idempotent — skip if owner_id already exists)
  const existing = await sb.from('subscriptions').select('id,name').eq('workspace_id', ws.id).eq('owner_id', CATCHALL_OWNER).maybeSingle();
  if (existing.data) {
    console.log(`\n[4] catch-all enricher already exists: id=${existing.data.id}`);
  } else {
    const r = await callTool(
      sb,
      { workspace_id: ws.id, actor_kind: 'agent', actor_id: 'meta_signal_coverage_fix' },
      'create_subscription',
      {
        owner_kind: 'agent',
        owner_id: CATCHALL_OWNER,
        name: CATCHALL_NAME,
        semantic_query: CATCHALL_SEMANTIC,
        structured_filter: {},
        threshold: CATCHALL_THRESHOLD,
        action_on_match: 'agent.run',
      },
    );
    if (!r.ok) { console.log(`\n[4] catch-all create failed: ${r.error}`); }
    else {
      const upd = await sb.from('subscriptions').update({ agent_behavior: 'enricher' }).eq('id', r.target_id);
      if (upd.error) console.log(`[4] created sub ${r.target_id} but agent_behavior update failed: ${upd.error.message}`);
      else console.log(`\n[4] catch-all enricher created: id=${r.target_id} threshold=${CATCHALL_THRESHOLD}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
