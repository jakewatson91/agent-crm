/**
 * Test the two claims a reallocation proposal would rest on, before proposing it.
 *
 * CLAIM 1: "repeat visits are worth half a first visit, so move the budget."
 *   The confound is obvious and fatal if true: we revisit HIGH-SCORING accounts
 *   by design. So a first-visit yield of 0.98 vs 0.51 on repeats may just be the
 *   shape of any account's first look — nothing deduped yet, whole web unread —
 *   and the accounts we would move budget TO would decay the same way on their
 *   own second visit. That would make reallocation a wash.
 *
 *   The test: yield by VISIT NUMBER, within the same accounts. If visit 1 is rich
 *   and visit 5 is poor for the same account, the decay is real and the fix is to
 *   stop going back so often. If yield is flat across visit numbers, the 0.51 is
 *   about which accounts they are, not how often we visit, and reallocating buys
 *   nothing.
 *
 * CLAIM 2: "81,295 fact rewrites a month are the scoring loop."
 *   Inferred from event names, never checked. Count the actual predicates.
 *
 * Reads only.
 *
 * Usage: pnpm tsx scripts/_cost_10_check_my_claims.ts [--days 30]
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const argv = process.argv.slice(2);
let DAYS = 30;
for (let i = 0; i < argv.length; i++) if (argv[i] === '--days') DAYS = Number(argv[++i]) || DAYS;

async function pageAll<T>(build: (f: number, t: number) => any): Promise<T[]> {
  let out: T[] = []; let f = 0;
  for (;;) {
    const { data, error } = await build(f, f + 999);
    if (error) throw error;
    if (!data?.length) break;
    out = out.concat(data);
    if (data.length < 1000) break;
    f += 1000;
  }
  return out;
}

(async () => {
  const since = new Date(Date.now() - DAYS * 86400 * 1000).toISOString();

  // ---------- CLAIM 1 ----------
  const runs = await pageAll<any>((f, t) => sb.from('events')
    .select('target_id, created_at, payload').eq('workspace_id', WS)
    .eq('action', 'research_completed').gte('created_at', since)
    .order('created_at', { ascending: true }).range(f, t));

  const seq = new Map<string, number>();
  const byVisitNo = new Map<number, { searches: number; kept: number; runs: number }>();
  for (const r of runs) {
    const id = r.target_id;
    if (!id) continue;
    const n = (seq.get(id) ?? 0) + 1;
    seq.set(id, n);
    const bucket = Math.min(n, 10); // 10+ collapses into one
    const b = byVisitNo.get(bucket) ?? { searches: 0, kept: 0, runs: 0 };
    b.searches += r.payload?.searches ?? 0;
    b.kept += r.payload?.results_created ?? 0;
    b.runs++;
    byVisitNo.set(bucket, b);
  }

  console.log(`\nCLAIM 1 — does yield fall with each repeat visit to the SAME account?\n`);
  console.log(`  ${'visit #'.padEnd(9)}${'runs'.padStart(7)}${'searches'.padStart(10)}${'kept'.padStart(7)}${'kept/search'.padStart(13)}`);
  for (let n = 1; n <= 10; n++) {
    const b = byVisitNo.get(n);
    if (!b) continue;
    const label = n === 10 ? '10th+' : `${n}`;
    console.log(`  ${label.padEnd(9)}${String(b.runs).padStart(7)}${String(b.searches).padStart(10)}${String(b.kept).padStart(7)}${(b.kept / (b.searches || 1)).toFixed(2).padStart(13)}`);
  }

  const first = byVisitNo.get(1);
  const later = [...byVisitNo.entries()].filter(([n]) => n >= 4)
    .reduce((a, [, v]) => ({ searches: a.searches + v.searches, kept: a.kept + v.kept }), { searches: 0, kept: 0 });
  const y1 = (first?.kept ?? 0) / (first?.searches || 1);
  const yLater = later.kept / (later.searches || 1);
  console.log(`\n  first visit        ${y1.toFixed(2)} kept/search`);
  console.log(`  4th visit onward   ${yLater.toFixed(2)} kept/search`);
  console.log(`  decay              ${y1 > 0 ? `${((1 - yLater / y1) * 100).toFixed(0)}% lower` : 'n/a'}`);
  console.log(`\n  VERDICT: ${yLater < y1 * 0.75
    ? 'the decay is REAL and within-account. Visiting the same account again genuinely returns less,\n           so moving that budget to unvisited accounts buys more. The proposal stands.'
    : 'yield does NOT fall much with repeat visits. The 0.51 was about WHICH accounts, not how often.\n           Reallocating would be a wash. DROP the proposal.'}`);

  // ---------- CLAIM 2 ----------
  const sup = await pageAll<any>((f, t) => sb.from('events').select('payload')
    .eq('workspace_id', WS).eq('action', 'supersede_fact').gte('created_at', since).range(f, t));
  const byPred = new Map<string, number>();
  for (const e of sup) {
    const p = e.payload ?? {};
    const pred = p.predicate ?? p.fact?.predicate ?? p.new?.predicate ?? 'unstated';
    byPred.set(pred, (byPred.get(pred) ?? 0) + 1);
  }
  console.log(`\n\nCLAIM 2 — what are the ${sup.length.toLocaleString()} fact rewrites actually rewriting?\n`);
  const top = [...byPred.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  for (const [p, n] of top) {
    console.log(`  ${String(n).padStart(7)}  ${p}  ${((n / sup.length) * 100).toFixed(1)}%`);
  }
  if (top.length === 1 && top[0]![0] === 'unstated') {
    console.log(`  (no predicate on the payload — sample: ${JSON.stringify(sup[0]?.payload).slice(0, 300)})`);
  }
  const scoreish = [...byPred.entries()].filter(([p]) => p.startsWith('score') || p.includes('icp'))
    .reduce((n, [, v]) => n + v, 0);
  console.log(`\n  rewrites of score-shaped predicates: ${scoreish.toLocaleString()} of ${sup.length.toLocaleString()} (${((scoreish / (sup.length || 1)) * 100).toFixed(0)}%)`);
  console.log(`  VERDICT: ${scoreish > sup.length * 0.6
    ? 'yes — the churn IS the scoring loop rewriting its own numbers.'
    : 'NO — scoring is not the main rewriter. My earlier claim was wrong; see the breakdown above.'}`);
})();
