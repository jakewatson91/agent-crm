/**
 * Undo fork "repairs" applied to multi-valued predicates.
 *
 * repair_fact_forks.ts assumed one current row per (entity, predicate). That
 * holds for score predicates — scoreAndAssert always supersedes, so two current
 * rows means a concurrency race — but it is WRONG for content predicates. A
 * company genuinely has several `product` rows and several `country` rows, and
 * evidence_depth counts exactly that. Chaining them left only the newest
 * visible and quietly shrank the fact base the agent reads.
 *
 * The links to undo are identifiable exactly: a legitimate supersede is written
 * through `act(... 'supersede_fact')`, which records an event carrying the
 * superseded id. repair_fact_forks.ts wrote its pointers with a direct UPDATE
 * and produced no event. So any fact row whose `supersedes` value never appears
 * in a supersede_fact event was set by the repair, not by the pipeline.
 *
 * Usage:
 *   tsx scripts/revert_fact_fork_repair.ts <workspace_id> [--apply]
 *
 * Dry run by default. Score predicates are left alone.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

/** Written by scoreAndAssert, which always supersedes: one current row is correct. */
const SINGLE_VALUED = new Set([
  'icp_fit', 'score_total', 'score_recency', 'icp_fit_breakdown',
  'score_industry_match', 'score_stage_match', 'score_signal_strength',
  'score_evidence_depth', 'score_graph_proximity', 'contact_score',
]);

async function pageAll<T>(q: (f: number, t: number) => any, P = 500): Promise<T[]> {
  const out: T[] = [];
  for (let f = 0; ; f += P) {
    const { data, error } = await q(f, f + P - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if ((data ?? []).length < P) break;
  }
  return out;
}

async function main() {
  const WS = process.argv[2];
  const APPLY = process.argv.includes('--apply');
  if (!WS) { console.error('usage: tsx scripts/revert_fact_fork_repair.ts <workspace_id> [--apply]'); process.exit(1); }

  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

  // Project just the JSON field — supersede_fact payloads carry full object_text
  // and pulling them whole times the query out.
  const evs = await pageAll<{ sup: string | null }>((f, t) => sb.from('events')
    .select('sup:payload->supersedes')
    .eq('workspace_id', WS).eq('action', 'supersede_fact').order('id').range(f, t), 500);
  const legit = new Set<string>();
  for (const e of evs) if (e.sup) legit.add(String(e.sup));
  console.log(`supersede_fact events: ${evs.length}   distinct superseded ids: ${legit.size}`);

  const rows = await pageAll<{ id: string; predicate: string; supersedes: string }>((f, t) => sb.from('facts')
    .select('id, predicate, supersedes')
    .eq('workspace_id', WS).not('supersedes', 'is', null).order('id').range(f, t), 1000);
  const orphan = rows.filter((r) => !legit.has(r.supersedes));
  const target = orphan.filter((r) => !SINGLE_VALUED.has(r.predicate));
  const kept = orphan.filter((r) => SINGLE_VALUED.has(r.predicate));

  console.log(`fact rows with supersedes set: ${rows.length}`);
  console.log(`  no matching supersede_fact event: ${orphan.length}`);
  console.log(`  to revert (multi-valued content predicates): ${target.length}`);
  console.log(`  left alone (single-valued score predicates): ${kept.length}`);
  const byPred = new Map<string, number>();
  for (const r of target) byPred.set(r.predicate, (byPred.get(r.predicate) ?? 0) + 1);
  console.log('  breakdown:', [...byPred.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `${k}=${v}`).join('  '));

  if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.'); return; }

  let done = 0, failed = 0;
  for (const r of target) {
    const { error } = await sb.from('facts').update({ supersedes: null }).eq('id', r.id);
    if (error) { failed++; if (failed <= 5) console.error(`  FAILED ${r.id}: ${error.message}`); }
    else done++;
    if (done && done % 200 === 0) console.log(`  ...${done}/${target.length}`);
  }
  console.log(`\nreverted ${done} links, ${failed} failed.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
