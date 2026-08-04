/**
 * Recombine every stored icp_fit for a workspace under the CURRENT scoring
 * formula, without asking the model anything.
 *
 * Run this after a change to how sub-scores are combined (weights, a dimension
 * becoming droppable, a deterministic dimension being recomputed). The three
 * judged dimensions — industry_match, stage_match, signal_strength — are read
 * back from the stored breakdown and reused verbatim, so this costs no LLM
 * calls and cannot churn the model's opinion. Only the arithmetic changes.
 *
 * It also rewrites each breakdown's inputs_hash under the current hashing
 * scheme, so the live scorer's reuse path recognises these as already-answered
 * and does not re-roll the whole book on its next tick.
 *
 * Usage:
 *   tsx scripts/recombine_scores.ts <workspace_id> [--apply] [--limit N]
 *
 * Defaults to a dry run: prints the before/after distribution and the biggest
 * movers, writes nothing.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { act } from '@agent-crm/primitives';
import {
  combineSubScores, buildScoreWeights, scoreInputsHash, isSubstantiveFact,
  type ScoreBreakdown,
} from '../packages/tools/src/scoring.ts';

const RECENCY_TAU_DAYS = 45;
const GROUND_TRUTH_KEYS = [
  'team_size', 'headcount_range', 'stage', 'funding_stage', 'founded_year',
  'public_private', 'annual_revenue_range', 'hq', 'location', 'industry',
];

type Fact = {
  id: string; subject_entity: string; predicate: string; object_text: string | null;
  object_entity: string | null; observed_at: string; signal_id: string | null;
};

async function fetchAll<T>(q: (f: number, t: number) => any): Promise<T[]> {
  const PAGE = 1000; const out: T[] = [];
  for (let f = 0; ; f += PAGE) {
    const { data, error } = await q(f, f + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if ((data ?? []).length < PAGE) break;
  }
  return out;
}

function deciles(label: string, xs: number[]) {
  const d = new Array(10).fill(0);
  for (const s of xs) d[Math.min(9, Math.max(0, Math.floor(s * 10)))]++;
  const mx = Math.max(...d, 1);
  console.log(`\n${label}  (n=${xs.length})`);
  d.forEach((n, i) => console.log(`  ${(i / 10).toFixed(1)} ${String(n).padStart(4)} ${((n / xs.length) * 100).toFixed(0).padStart(3)}% ${'#'.repeat(Math.round(n / mx * 38))}`));
}

async function main() {
  const WS = process.argv[2];
  const APPLY = process.argv.includes('--apply');
  const limArg = process.argv.indexOf('--limit');
  const LIMIT = limArg > -1 ? parseInt(process.argv[limArg + 1] ?? '0', 10) : 0;
  if (!WS) { console.error('usage: tsx scripts/recombine_scores.ts <workspace_id> [--apply] [--limit N]'); process.exit(1); }

  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const actor = { workspace_id: WS, actor_kind: 'system' as const, actor_id: 'recombine_scores' };

  const { data: ws } = await sb.from('workspaces').select('icp, about, persona, policy').eq('id', WS).maybeSingle();
  if (!ws) { console.error('workspace not found'); process.exit(1); }
  const weights = buildScoreWeights((ws.policy?.scoring ?? {}).weights);
  const stageFactName = (ws.policy?.lifecycle as { stage_fact_name?: string } | undefined)?.stage_fact_name;
  const substantive = (p: string) => isSubstantiveFact(p, stageFactName);

  // One read of EVERY fact row in the workspace, then everything else is local.
  // Per-entity queries would be ~2000 round trips.
  //
  // Deliberately not filtered with .is('supersedes', null). supersede_fact
  // writes the NEW row carrying supersedes=<old id>, so a null supersedes marks
  // the original at the bottom of the chain, not the current value. Filtering on
  // it hands back stale rows and, worse, superseding one of them forks the chain
  // and leaves two live values. Current = the row no other row points at.
  const allRows = await fetchAll<Fact & { supersedes: string | null }>((f, t) => sb.from('facts')
    .select('id, subject_entity, predicate, object_text, object_entity, observed_at, signal_id, supersedes')
    .eq('workspace_id', WS).order('id').range(f, t));
  const pointedTo = new Set(allRows.map((r) => r.supersedes).filter((x): x is string => !!x));
  const facts = allRows.filter((r) => !pointedTo.has(r.id));
  console.log(`fact rows: ${allRows.length}   current (not superseded by anything): ${facts.length}`);

  const byEnt = new Map<string, Fact[]>();
  const linked = new Set<string>();
  for (const f of facts) {
    if (!byEnt.has(f.subject_entity)) byEnt.set(f.subject_entity, []);
    byEnt.get(f.subject_entity)!.push(f);
    if (f.object_entity) { linked.add(f.subject_entity); linked.add(f.object_entity); }
  }
  // A forked chain leaves more than one current row for the same predicate. The
  // recombination would pick one arbitrarily and fork it again, so refuse and
  // let scripts/repair_fact_forks.ts linearize them first.
  const forked = [...byEnt.entries()].flatMap(([ent, fs]) => {
    const seen = new Map<string, number>();
    for (const f of fs) seen.set(f.predicate, (seen.get(f.predicate) ?? 0) + 1);
    return [...seen.entries()].filter(([, n]) => n > 1).map(([p]) => `${ent}:${p}`);
  });
  const forkedEnts = new Set(forked.map((k) => k.split(':')[0]!));
  if (forked.length) {
    console.warn(`\nSKIPPING ${forkedEnts.size} entities: ${forked.length} (entity, predicate) pairs have more than one current row.`);
    console.warn('Run `tsx scripts/repair_fact_forks.ts <workspace_id> --apply` to linearize them, then re-run.');
    console.warn('first 5:', forked.slice(0, 5).join('  '));
  }

  // Publish dates for the signals behind those facts — the same source the
  // scorer now dates recency from.
  const sigIds = [...new Set(facts.map((f) => f.signal_id).filter((x): x is string => !!x))];
  const pub = new Map<string, string>();
  for (let i = 0; i < sigIds.length; i += 150) {
    const { data } = await sb.from('signals').select('id, structured_tags').eq('workspace_id', WS).in('id', sigIds.slice(i, i + 150));
    for (const s of (data ?? []) as Array<{ id: string; structured_tags: { published_at?: string } | null }>) {
      const p = s.structured_tags?.published_at;
      if (p && Number.isFinite(Date.parse(p))) pub.set(s.id, p);
    }
  }
  console.log(`signals with a publish date: ${pub.size}/${sigIds.length}`);

  const targets = [...byEnt.keys()]
    .filter((e) => !forkedEnts.has(e))
    .filter((e) => byEnt.get(e)!.some((f) => f.predicate === 'icp_fit_breakdown'));
  const entAttrs = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < targets.length; i += 150) {
    const { data } = await sb.from('entities').select('id, name, attributes').in('id', targets.slice(i, i + 150));
    for (const e of (data ?? []) as Array<{ id: string; attributes: Record<string, unknown> | null }>) entAttrs.set(e.id, e.attributes ?? {});
  }

  const now = Date.now();
  const plan: Array<{ ent: string; before: number; after: number; bd: ScoreBreakdown; hash: string; curBdId: string }> = [];
  let skippedUnparseable = 0;
  let skippedCurrent = 0;

  for (const ent of targets) {
    const fs = byEnt.get(ent)!;
    const bdFact = fs.find((f) => f.predicate === 'icp_fit_breakdown');
    if (!bdFact?.object_text) continue;
    let o: any;
    try { o = JSON.parse(bdFact.object_text); } catch { skippedUnparseable++; continue; }
    if (typeof o.industry_match !== 'number' || typeof o.signal_strength !== 'number') { skippedUnparseable++; continue; }

    const attrs = entAttrs.get(ent) ?? {};
    const hasGroundTruth = GROUND_TRUTH_KEYS.some((k) => attrs[k] != null && attrs[k] !== '');

    // recency, dated off the source where we have one — same rule as scoring.ts
    const real = fs.filter((f) => substantive(f.predicate));
    let mostRecent = 0;
    for (const f of real) {
      const p = f.signal_id ? pub.get(f.signal_id) : undefined;
      const t = Date.parse(p ?? f.observed_at);
      if (Number.isFinite(t) && t > mostRecent) mostRecent = t;
    }
    const recency = real.length && mostRecent
      ? Math.max(0, Math.min(1, Math.exp(-Math.max(0, (now - mostRecent) / 86400_000) / RECENCY_TAU_DAYS)))
      : 0;

    const unknown_dims: string[] = [];
    if (!linked.has(ent)) unknown_dims.push('graph_proximity');
    if (!hasGroundTruth) unknown_dims.push('stage_match');

    const bd: ScoreBreakdown = {
      industry_match: o.industry_match,
      stage_match: typeof o.stage_match === 'number' ? o.stage_match : 0,
      signal_strength: o.signal_strength,
      evidence_depth: typeof o.evidence_depth === 'number' ? o.evidence_depth : 0,
      recency,
      graph_proximity: typeof o.graph_proximity === 'number' ? o.graph_proximity : 0,
      rrf_prefilter: typeof o.rrf_prefilter === 'number' ? o.rrf_prefilter : 0,
      unknown_dims,
    };
    const after = combineSubScores(bd, weights);
    const beforeFact = fs.find((f) => f.predicate === 'icp_fit');
    const before = beforeFact?.object_text ? parseFloat(beforeFact.object_text) : NaN;

    // outOfScope must be passed here too, or this hash disagrees with the one
    // scoring.ts computes and the alreadyDone guard below can never match —
    // every run would write a redundant supersede row per entity.
    const hash = scoreInputsHash({
      factIds: real.map((f) => f.id),
      attributes: attrs,
      icp: ws.icp, about: ws.about, persona: ws.persona,
      outOfScope: Array.isArray(ws.policy?.drafter?.out_of_scope)
        ? (ws.policy!.drafter!.out_of_scope as string[]).filter((s) => s.trim())
        : [],
    });
    // Already recombined under this formula and the number hasn't moved: skip,
    // so re-running (or resuming after an interrupted pass) doesn't append a
    // redundant supersede row per entity.
    const alreadyDone = Array.isArray(o.unknown_dims)
      && o.inputs_hash === hash
      && Number.isFinite(before)
      && Math.abs(before - after) < 0.005;
    if (alreadyDone) { skippedCurrent++; continue; }

    plan.push({ ent, before, after, bd, hash, curBdId: bdFact.id });
  }

  const befores = plan.map((p) => p.before).filter(Number.isFinite);
  const afters = plan.map((p) => p.after);
  deciles('BEFORE', befores);
  deciles('AFTER', afters);
  const sd = (xs: number[]) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length); };
  console.log(`\nstd dev  before=${sd(befores).toFixed(4)}  after=${sd(afters).toFixed(4)}`);
  console.log(`entities to rewrite: ${plan.length}   unparseable: ${skippedUnparseable}   already current: ${skippedCurrent}`);

  if (!APPLY) {
    const movers = [...plan].filter((p) => Number.isFinite(p.before)).sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before)).slice(0, 8);
    const { data: nm } = await sb.from('entities').select('id, name').in('id', movers.map((m) => m.ent));
    const names = new Map((nm ?? []).map((e: any) => [e.id, e.name]));
    console.log('\nbiggest movers:');
    for (const m of movers) console.log(`  ${String(names.get(m.ent) ?? m.ent).padEnd(30)} ${m.before.toFixed(2)} -> ${m.after.toFixed(2)}  dropped=${JSON.stringify(m.bd.unknown_dims)}`);
    console.log('\nDRY RUN — nothing written. Re-run with --apply to commit.');
    return;
  }

  // ---- write ----
  // Same supersede discipline as scoreAndAssert: the CURRENT row is the one no
  // other row points at. Only the predicates this recombination can change are
  // rewritten; the judged sub-scores are untouched, so their facts still stand.
  const work = LIMIT > 0 ? plan.slice(0, LIMIT) : plan;
  let done = 0, failed = 0;
  for (const p of work) {
    try {
      const bdText = JSON.stringify({
        ...p.bd,
        reasoning: (() => { try { return JSON.parse(byEnt.get(p.ent)!.find((f) => f.predicate === 'icp_fit_breakdown')!.object_text!).reasoning ?? ''; } catch { return ''; } })(),
        inputs_hash: p.hash,
      });
      await act(sb, actor, { tool: 'supersede_fact', args: { subject_entity: p.ent, predicate: 'icp_fit_breakdown', object_text: bdText, confidence: 0.85, supersedes: p.curBdId } });

      for (const pred of ['icp_fit', 'score_total', 'score_recency'] as const) {
        const value = pred === 'score_recency' ? p.bd.recency : p.after;
        const cur = byEnt.get(p.ent)!.find((f) => f.predicate === pred);
        if (cur) {
          await act(sb, actor, { tool: 'supersede_fact', args: { subject_entity: p.ent, predicate: pred, object_text: value.toFixed(2), confidence: 0.9, supersedes: cur.id } });
        } else {
          await act(sb, actor, { tool: 'assert_fact', args: { subject_entity: p.ent, predicate: pred, object_text: value.toFixed(2), confidence: 0.9 } });
        }
      }
      done++;
      if (done % 100 === 0) console.log(`  ...${done}/${work.length}`);
    } catch (e) {
      failed++;
      if (failed <= 5) console.error(`  FAILED ${p.ent}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`\nrewrote ${done} entities, ${failed} failed.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
