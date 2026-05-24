/**
 * One-shot cleanup ahead of the new signal process.
 *
 *   1. Disable the two dead-weight sources flagged by sweep:
 *      ats_hiring_main (214 signals, 0 fact yield) and hn_u2u2 (74, 0).
 *      Reversible: set active=true.
 *   2. Delete all scorer-output facts (icp_fit, score_*, icp_fit_breakdown).
 *      Scores collapsed — 56% in decile 0. Also: scoreEntity's staleness guard
 *      uses score_total as the reference, so leaving any score_* row behind
 *      blocks the next rescore. Reversible: re-run scripts/rescore_all.ts.
 *
 * Does NOT touch: entities, contacts, channels, channel_posts, events,
 * signals, or any non-scorer fact.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const DEAD_SOURCES = ['ats_hiring_main', 'hn_u2u2'];
const SCORER_PREDS = [
  'icp_fit',
  'icp_fit_breakdown',
  'score_total',
  'score_industry_match',
  'score_stage_match',
  'score_signal_strength',
  'score_evidence_depth',
  'score_recency',
  'score_graph_proximity',
];

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const ws = await sb.from('workspaces').select('id, name')
    .like('name', 'demo · agent-crm%')
    .order('created_at', { ascending: false }).limit(1).single();
  if (!ws.data) throw new Error('no workspace matching "demo · agent-crm%"');
  const WS = ws.data.id as string;
  console.log(`workspace: ${ws.data.name}  (${WS.slice(0, 8)})\n`);

  // ---- PREVIEW ----
  const sources = await sb.from('sources')
    .select('id, name, active, last_run_status, last_run_summary')
    .eq('workspace_id', WS).in('name', DEAD_SOURCES);
  console.log('sources to disable:');
  for (const s of (sources.data ?? []) as Array<{ name: string; active: boolean; last_run_status: string | null; last_run_summary: { signals_created?: number } | null }>) {
    const sigs = s.last_run_summary?.signals_created ?? '?';
    console.log(`  ${s.active ? '[on]  ' : '[off] '} ${s.name.padEnd(20)} last_run=${s.last_run_status ?? 'never'}  signals_created=${sigs}`);
  }

  const scorerCount = await sb.from('facts').select('id', { count: 'exact', head: true })
    .eq('workspace_id', WS).in('predicate', SCORER_PREDS);
  console.log(`\nscorer-output facts to delete: ${scorerCount.count}`);
  console.log(`  (predicates: ${SCORER_PREDS.join(', ')})\n`);

  // ---- EXECUTE ----
  const off = await sb.from('sources').update({ active: false })
    .eq('workspace_id', WS).in('name', DEAD_SOURCES).eq('active', true).select('name');
  if (off.error) throw off.error;
  console.log(`[1/2] sources disabled: ${(off.data ?? []).map((r: any) => r.name).join(', ') || '(none — already off)'}`);

  const del = await sb.from('facts').delete()
    .eq('workspace_id', WS).in('predicate', SCORER_PREDS).select('id');
  if (del.error) throw del.error;
  console.log(`[2/2] scorer-output facts deleted: ${(del.data ?? []).length}`);

  // ---- VERIFY ----
  const after = await sb.from('facts').select('id', { count: 'exact', head: true })
    .eq('workspace_id', WS).in('predicate', SCORER_PREDS);
  const stillActive = await sb.from('sources').select('name')
    .eq('workspace_id', WS).in('name', DEAD_SOURCES).eq('active', true);
  console.log(`\npost-state: scorer_facts=${after.count}  still-active dead sources=${(stillActive.data ?? []).length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
