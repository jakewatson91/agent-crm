/**
 * One-off cleanup for the activity-marker migration.
 *
 * 1. Delete the research_triggered / research_completed / contacts_requested /
 *    contacts_completed rows from `facts` — they moved to the event log and were
 *    inflating evidence_depth + recency in scoring.
 * 2. Deterministically rescore every account that already has a score: recompute
 *    ONLY evidence_depth + recency (both pure arithmetic over the cleaned facts),
 *    keep the existing LLM/graph sub-scores, recombine the total. No embeddings,
 *    no DeepSeek — $0, and it dodges the skip-when-stale guard.
 *
 * Dry-run by default. Pass --apply to delete + write.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { act } from '@agent-crm/primitives';
import { combineSubScores, buildScoreWeights, isSubstantiveFact, type ScoreBreakdown } from '@agent-crm/tools';

const WS = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
const MARKERS = ['research_triggered', 'research_completed', 'research_error', 'contacts_requested', 'contacts_completed'];
// Mirror scoring.ts (these constants are module-private there).
const RECENCY_TAU_DAYS = 45;
const EVIDENCE_FULL = 6;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

interface FactRow { id: string; predicate: string; object_text: string | null; observed_at: string; created_at: string; supersedes: string | null; }

function evidenceDepth(facts: FactRow[]): number {
  return clamp01(facts.filter((f) => isSubstantiveFact(f.predicate)).length / EVIDENCE_FULL);
}
function recencyScore(facts: FactRow[]): number {
  const real = facts.filter((f) => isSubstantiveFact(f.predicate));
  let mostRecent = 0;
  for (const f of real) {
    const t = Date.parse(f.observed_at ?? f.created_at ?? '');
    if (Number.isFinite(t) && t > mostRecent) mostRecent = t;
  }
  if (!mostRecent) return 0;
  return clamp01(Math.exp(-((Date.now() - mostRecent) / 86400_000) / RECENCY_TAU_DAYS));
}
const num = (rows: FactRow[], pred: string): number => {
  const f = rows.find((r) => r.predicate === pred);
  const v = f ? parseFloat(f.object_text ?? '') : NaN;
  return Number.isFinite(v) ? v : 0;
};

async function main() {
  const apply = process.argv.includes('--apply');
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const actor = { workspace_id: WS, actor_kind: 'system' as const, actor_id: 'cleanup_marker_migration' };
  console.log(`MODE: ${apply ? 'APPLY' : 'DRY-RUN'}\n`);

  // Use the workspace's real scoring weights so the recomputed total matches
  // what a live rescore would produce (falls back to defaults per-key).
  const wsRow = await sb.from('workspaces').select('policy').eq('id', WS).maybeSingle();
  const weights = buildScoreWeights((wsRow.data?.policy as any)?.scoring?.weights);
  console.log('weights:', JSON.stringify(weights));

  // ---- 1. marker fact rows (blast radius, all workspaces) ----
  console.log('Marker fact rows to delete:');
  let totalDel = 0;
  for (const pred of MARKERS) {
    const { count } = await sb.from('facts').select('id', { count: 'exact', head: true }).eq('predicate', pred);
    console.log(`  ${pred}: ${count ?? 0}`);
    totalDel += count ?? 0;
  }
  console.log(`  TOTAL: ${totalDel}`);
  if (apply && totalDel) {
    // Delete in id-pages — a single 2.5k-row delete hits the statement timeout.
    let deleted = 0;
    for (;;) {
      const page = await sb.from('facts').select('id').in('predicate', MARKERS).limit(500);
      const ids = (page.data ?? []).map((r: any) => r.id);
      if (!ids.length) break;
      const del = await sb.from('facts').delete().in('id', ids);
      if (del.error) throw new Error(del.error.message);
      deleted += ids.length;
      process.stdout.write(`\r  deleted ${deleted}/${totalDel}`);
    }
    console.log(`\n  deleted ${deleted} rows`);
  }

  // ---- 2. deterministic rescore of scored accounts ----
  const stRows = await sb.from('facts').select('subject_entity, supersedes, id')
    .eq('workspace_id', WS).eq('predicate', 'score_total');
  const pointed = new Set((stRows.data ?? []).map((r: any) => r.supersedes).filter(Boolean));
  const scored = [...new Set((stRows.data ?? []).filter((r: any) => !pointed.has(r.id)).map((r: any) => r.subject_entity))] as string[];
  console.log(`\nScored accounts to recompute: ${scored.length}`);

  async function upsert(entity_id: string, predicate: string, text: string) {
    const rows = ((await sb.from('facts').select('id, supersedes, observed_at')
      .eq('workspace_id', WS).eq('subject_entity', entity_id).eq('predicate', predicate)
      .order('observed_at', { ascending: false })).data ?? []) as Array<{ id: string; supersedes: string | null }>;
    const pt = new Set(rows.map((r) => r.supersedes).filter(Boolean));
    const current = rows.find((r) => !pt.has(r.id)) ?? null;
    await act(sb, actor, {
      tool: current ? 'supersede_fact' : 'assert_fact',
      args: { subject_entity: entity_id, predicate, object_text: text, confidence: 0.9, ...(current ? { supersedes: current.id } : {}) },
    });
  }

  let changed = 0, sample = 0;
  for (const eid of scored) {
    const raw = ((await sb.from('facts').select('id, predicate, object_text, observed_at, created_at, supersedes')
      .eq('workspace_id', WS).eq('subject_entity', eid)).data ?? []) as FactRow[];
    const supSet = new Set(raw.map((f) => f.supersedes).filter(Boolean));
    const active = raw.filter((f) => !supSet.has(f.id));

    const oldEv = num(active, 'score_evidence_depth');
    const oldRec = num(active, 'score_recency');
    const ev = evidenceDepth(active);
    const rec = recencyScore(active);
    let rrf = 0;
    const bj = active.find((f) => f.predicate === 'icp_fit_breakdown');
    if (bj?.object_text) { try { rrf = (JSON.parse(bj.object_text).rrf_prefilter as number) ?? 0; } catch { /* keep 0 */ } }

    const breakdown: ScoreBreakdown = {
      industry_match: num(active, 'score_industry_match'),
      stage_match: num(active, 'score_stage_match'),
      signal_strength: num(active, 'score_signal_strength'),
      evidence_depth: ev,
      recency: rec,
      graph_proximity: num(active, 'score_graph_proximity'),
      rrf_prefilter: rrf,
    };
    const total = combineSubScores(breakdown, weights);
    const oldTotal = num(active, 'score_total');

    if (sample < 5) {
      console.log(`  e.g. ${eid.slice(0, 8)}  ev ${oldEv.toFixed(2)}->${ev.toFixed(2)}  rec ${oldRec.toFixed(2)}->${rec.toFixed(2)}  total ${oldTotal.toFixed(2)}->${total.toFixed(2)}`);
      sample++;
    }
    if (apply) {
      await upsert(eid, 'score_evidence_depth', ev.toFixed(2));
      await upsert(eid, 'score_recency', rec.toFixed(2));
      await upsert(eid, 'score_total', total.toFixed(2));
      await upsert(eid, 'icp_fit', total.toFixed(2));
      await upsert(eid, 'icp_fit_breakdown', JSON.stringify(breakdown));
    }
    changed++;
  }
  console.log(`\n${apply ? 'Rewrote' : 'Would rewrite'} scores for ${changed} accounts.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
