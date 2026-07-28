/**
 * Scoring v2 — multi-dimensional rubric, graph features, RRF pre-filter.
 *
 * Pipeline:
 *   1. Load entity + facts + workspace ICP/about.
 *   2. Compute deterministic sub-scores: evidence_depth, recency, graph_proximity.
 *   3. Build entity perspective embeddings (pain/stack/vertical) from facts.
 *      Cosine each against the cached ICP perspectives, fuse via RRF.
 *   4. If the RRF pre-filter is < 0.3, skip the LLM entirely — return a low
 *      score with reasoning, save the call.
 *   5. Otherwise call the LLM rubric: industry_match, stage_match, signal_strength.
 *   6. Combine into icp_total via a transparent weighted-sum formula.
 *   7. Assert every sub-score as its own fact for audit + future calibration.
 *
 * Backward compat: keeps writing `icp_fit` = icp_total as the rolling total
 * fact, so the drafter prompt and UI badges that read `icp_fit` keep working.
 */
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { embed } from '@agent-crm/primitives';
import { act } from '@agent-crm/primitives';
import { graphProximity } from './graph.ts';
import { getIcpPerspectiveVectors, cosine, rrfFuse, type Perspective } from './icp_embeddings.ts';
import { chatCompleteForWorkspace } from './chat_workspace.ts';

const SCORE_MODEL = 'deepseek-v4-flash';
const DEFAULT_RRF_GATE = 0.3;           // below this, skip LLM
const RECENCY_TAU_DAYS = 45;    // exponential decay constant

/**
 * Age weight in (0,1] for a source published at `publishedAt`, halving every
 * `halfLifeDays`. Unknown/unparseable date returns 1 (an undated evergreen page
 * isn't penalized). Floored at 0.05 so a very old source that slips a hard gate
 * still carries a trace of weight rather than exactly zero. Used to decay a
 * research signal's magnitude by how old the underlying article is.
 */
export function ageDecay(publishedAt: string | null | undefined, halfLifeDays: number): number {
  if (!publishedAt || !(halfLifeDays > 0)) return 1;
  const t = Date.parse(publishedAt);
  if (!Number.isFinite(t)) return 1;
  const ageDays = (Date.now() - t) / 86400_000;
  if (ageDays <= 0) return 1;
  return Math.max(0.05, Math.pow(2, -ageDays / halfLifeDays));
}

// Bookkeeping facts that are NOT substantive evidence about the account — score
// outputs, lifecycle flags, cooldown timers. Excluded from evidence_depth and
// recency. This is the single canonical list: sweep.ts imports it too, so the
// scorer and the health sweep can never disagree about what counts as evidence
// (they used to, which is how the scorer counted self-pings as evidence).
//
// The research_triggered / research_completed / contacts_requested /
// contacts_completed names are kept here as transition safety: they moved to the
// event log, but leaving them in the denylist neutralizes any straggler rows.
export const ADMIN_PREDICATES = new Set([
  'icp_fit',
  'icp_fit_breakdown',
  'domain',
  'contact_lookup_attempted',
  'dropped_until',
  'outreach_cooldown_until',
  'last_outreach_at',
  'no_reply_marked',
  'outreach_rejected_at',
  'replied_at',
  'research_triggered',
  'research_completed',
  'research_error',
  'contacts_requested',
  'contacts_completed',
  'score_industry_match',
  'score_stage_match',
  'score_evidence_depth',
  'score_signal_strength',
  'score_recency',
  'score_graph_proximity',
  'score_total',
  'contact_score',
  // Outreach lifecycle marker (DEFAULT_STAGE_FACT_NAME in lifecycle.ts — kept as
  // a literal here because importing lifecycle.ts would cycle through index.ts).
  // The enricher writes this ~1s AFTER it writes the score, so treating it as
  // evidence made every researched account permanently look like it had newer
  // evidence than its own score, which re-armed the stale-guard forever.
  // A workspace that renames the fact passes the custom name to
  // isSubstantiveFact / scoreEntity instead.
  'outreach_stage',
]);

// True when a fact is real evidence about the account (not bookkeeping, not a
// score output). The score_ prefix guard catches any future score_* sub-score
// without enumerating it. Use this everywhere "does the account have evidence"
// is asked, so the definition stays in one place.
export function isSubstantiveFact(predicate: string, stageFactName?: string): boolean {
  if (stageFactName && predicate === stageFactName) return false;
  return !ADMIN_PREDICATES.has(predicate) && !predicate.startsWith('score_');
}

/**
 * Fingerprint of everything the LLM rubric actually reads. Two scoring runs with
 * the same fingerprint MUST produce the same judgment, so the second one is pure
 * spend plus a chance to overwrite a good score with a re-rolled one.
 *
 * The scorer is a reasoning model and ignores `temperature` (measured: 8 runs on
 * identical input at unset vs 0 gave identical spread), so it cannot be pinned
 * by sampling settings. The only way to stop the number moving on unchanged
 * evidence is to not ask the question twice.
 *
 * Fact IDs are enough on their own: facts are immutable and a correction lands
 * as a new row with a new id via the supersede chain.
 */
export function scoreInputsHash(input: {
  factIds: string[];
  attributes: Record<string, unknown> | null;
  icp: unknown;
  about: string | undefined;
  persona: unknown;
}): string {
  // Only what the rubric prompt actually contains. Scoring weights and
  // scoring_config_state.changed_at deliberately do NOT go in here: neither
  // reaches the model, they only change how the sub-scores are combined
  // afterwards. Hashing them made every weight tweak or config touch look like
  // new evidence, so re-tuning one weight re-ran the rubric on the whole book
  // (1961 accounts on Sudden) to arrive at the same three judgments. Left out,
  // the staleness guard still lets a config change through — it reads
  // changed_at directly — and the reuse path then recombines the stored
  // judgment under the new weights for free.
  const payload = JSON.stringify({
    f: [...input.factIds].sort(),
    a: input.attributes ?? {},
    i: input.icp ?? {},
    b: input.about ?? '',
    p: input.persona ?? {},
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

export interface ScoreBreakdown {
  industry_match: number;
  stage_match: number;
  signal_strength: number;
  evidence_depth: number;
  recency: number;
  graph_proximity: number;
  rrf_prefilter: number;
  /**
   * Dimensions that could not be measured for this entity, so combineSubScores
   * leaves them out of the mean rather than averaging in a placeholder. The
   * numbers above are still filled in for display, but a dimension named here
   * contributed nothing to icp_fit. Two cases produce it today: no company
   * ground truth to judge stage_match from, and an entity with no graph edges
   * so graph_proximity has no neighbours to average.
   */
  unknown_dims?: string[];
}

export interface EntityScore {
  icp_fit: number;              // alias of icp_total, kept for backward compat
  icp_total: number;
  breakdown: ScoreBreakdown;
  reasoning: string;
  llm_called: boolean;          // false if RRF pre-filter shortcut fired
  /** Fingerprint of the evidence + config this score was computed from. Stored
   *  on the breakdown fact so a later run can tell "same inputs" from "new
   *  evidence" without re-running the rubric. See scoreInputsHash. */
  inputs_hash: string;
  /** True when this result reflects the standing stored judgment rather than a
   *  fresh one: either the LLM dimensions were reused because the inputs were
   *  unchanged, or scoreAndAssert dropped the write because a concurrent run had
   *  already recorded a score from identical inputs. Callers can read it as
   *  "nothing was written this run". */
  reused: boolean;
}

// ---------- helpers ----------

function clamp01(x: number): number { return Math.max(0, Math.min(1, x)); }

function evidenceDepth(facts: Array<{ predicate: string }>): number {
  const substantive = facts.filter((f) => isSubstantiveFact(f.predicate)).length;
  // 6 substantive facts = full depth. Linear up to that.
  return clamp01(substantive / 6);
}

/**
 * How fresh is what we know about this account.
 *
 * Dated off the SOURCE's publish date when we have one (`sourceDates`, keyed by
 * the fact's signal_id and read from signals.structured_tags.published_at), and
 * only off our own write time as a fallback.
 *
 * Our write time on its own does not measure the account at all. `observed_at`
 * is set when the enricher writes the fact, so an article from eighteen months
 * ago and one from this morning both land as "today" — measured on the Sudden
 * book, 1000 of 1000 facts had observed_at within a day of created_at, and
 * recency came out at 0.98 for essentially every account (p10 0.97, p90 0.98).
 * A dimension that reports the pipeline's own cron schedule is noise carrying
 * 10% of the weight. Research reaches back up to a year, so real publish dates
 * spread this across the full range instead.
 */
function recencyScore(
  facts: Array<{ predicate: string; created_at?: string; observed_at?: string; signal_id?: string | null }>,
  sourceDates?: Map<string, string>,
): number {
  // Freshness must mean "when did we last learn something real about the
  // account" — so only substantive facts count. Score outputs are rewritten
  // every scoring run; counting them pinned recency at ~1.0 forever.
  const real = facts.filter((f) => isSubstantiveFact(f.predicate));
  if (!real.length) return 0;
  let mostRecent = 0;
  for (const f of real) {
    const published = f.signal_id ? sourceDates?.get(f.signal_id) : undefined;
    const t = Date.parse(published ?? f.observed_at ?? f.created_at ?? '');
    if (Number.isFinite(t) && t > mostRecent) mostRecent = t;
  }
  if (!mostRecent) return 0;
  // A source can carry a publish date in the future (bad metadata, or a
  // scheduled post). Clamp the age at 0 so it scores as "today", never above 1.
  const ageDays = Math.max(0, (Date.now() - mostRecent) / 86400_000);
  return clamp01(Math.exp(-ageDays / RECENCY_TAU_DAYS));
}

/**
 * Publish dates for the signals behind a set of facts, keyed by signal_id.
 * Missing / unparseable dates are simply absent, so recencyScore falls back to
 * our own write time for those facts.
 */
async function loadSourceDates(
  supabase: SupabaseClient,
  workspace_id: string,
  facts: Array<{ signal_id?: string | null }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(facts.map((f) => f.signal_id).filter((x): x is string => !!x))];
  if (!ids.length) return out;
  // Chunked at 150 like every other .in() here: a long id list overflows the
  // PostgREST request URL and silently returns a short page.
  for (let i = 0; i < ids.length; i += 150) {
    const res = await supabase.from('signals').select('id, structured_tags')
      .eq('workspace_id', workspace_id).in('id', ids.slice(i, i + 150));
    for (const s of (res.data ?? []) as Array<{ id: string; structured_tags: { published_at?: string } | null }>) {
      const p = s.structured_tags?.published_at;
      if (p && Number.isFinite(Date.parse(p))) out.set(s.id, p);
    }
  }
  return out;
}

// Canonical ground-truth attribute keys. Connectors that fetch directory-style
// data populate any of these they have; the scorer treats them as hard facts.
// Anything not in this list is rendered as OTHER ATTRIBUTES (lower trust).
const GROUND_TRUTH_KEYS = [
  'team_size',
  'headcount_range',
  'stage',
  'funding_stage',
  'founded_year',
  'public_private',
  'annual_revenue_range',
  'hq',
  'location',
  'industry',
] as const;

function renderGroundTruth(attrs: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const k of GROUND_TRUTH_KEYS) {
    const v = attrs[k];
    if (v === undefined || v === null || v === '') continue;
    lines.push(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  }
  return lines.join('\n');
}

function renderOtherAttributes(attrs: Record<string, unknown>): string {
  const skip = new Set<string>([...GROUND_TRUTH_KEYS, 'yc_snapshot_hash', 'domain']);
  const entries = Object.entries(attrs).filter(([k, v]) =>
    !skip.has(k) && v !== null && v !== undefined && v !== '',
  );
  if (!entries.length) return '';
  return entries.map(([k, v]) => `  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join('\n');
}

function buildEntityPerspectiveText(
  entityName: string,
  entityAttributes: Record<string, unknown>,
  facts: Array<{ predicate: string; object_text: string | null }>,
): Record<Perspective, string> {
  const factLines = facts
    .filter((f) => !ADMIN_PREDICATES.has(f.predicate))
    .map((f) => `${f.predicate}=${f.object_text ?? ''}`)
    .join('\n');
  const attrStr = JSON.stringify(entityAttributes ?? {});

  // Group facts by perspective. Cheap keyword-based routing into buckets.
  // Imperfect — that's what the embedding model is for. We just need the text
  // weighted toward the right concepts.
  const painKeywords = /(pain|problem|need|gap|frustrat|burn|leak|cost|losing|complain)/i;
  const stackKeywords = /(stack|uses|integrat|build|deployed|platform|tool|technology|api|framework|language|database|infra)/i;
  const verticalKeywords = /(industry|vertical|market|segment|customer|target|sells_to|serves|category|sector)/i;

  const painLines = facts.filter((f) => painKeywords.test(f.predicate + ' ' + (f.object_text ?? ''))).map((f) => `${f.predicate}=${f.object_text}`).join('\n');
  const stackLines = facts.filter((f) => stackKeywords.test(f.predicate + ' ' + (f.object_text ?? ''))).map((f) => `${f.predicate}=${f.object_text}`).join('\n');
  const verticalLines = facts.filter((f) => verticalKeywords.test(f.predicate + ' ' + (f.object_text ?? ''))).map((f) => `${f.predicate}=${f.object_text}`).join('\n');

  return {
    default: `${entityName}\nAttributes: ${attrStr}\nFacts:\n${factLines}`.slice(0, 1500),
    pain: `${entityName} — pains and problems they face:\n${painLines || factLines}`.slice(0, 1500),
    stack: `${entityName} — technology stack and integrations:\n${stackLines || attrStr}`.slice(0, 1500),
    vertical: `${entityName} — industry and target market:\n${verticalLines || attrStr}`.slice(0, 1500),
  };
}

// ---------- main scoring ----------

export async function scoreEntity(
  supabase: SupabaseClient,
  workspace_id: string,
  entity_id: string,
): Promise<EntityScore | null> {
  const [entRes, factsRes, wsRes, graphRes, icpVecs] = await Promise.all([
    supabase.from('entities').select('id, name, attributes').eq('id', entity_id).maybeSingle(),
    supabase.from('facts').select('id, predicate, object_text, confidence, observed_at, created_at, supersedes, signal_id')
      .eq('workspace_id', workspace_id).eq('subject_entity', entity_id)
      .order('observed_at', { ascending: false }),
    supabase.from('workspaces').select('icp, about, persona, policy').eq('id', workspace_id).maybeSingle(),
    graphProximity(supabase, workspace_id, entity_id),
    getIcpPerspectiveVectors(supabase, workspace_id),
  ]);

  if (!entRes.data) return null;
  const entity = entRes.data as { name: string; attributes: Record<string, unknown> };
  // Candidate entities are thin connection points (name + is_a + domain, no
  // signals or embedding). Scoring one produces a meaningless number and
  // pollutes the score distribution. Skip until it is promoted to a full entity.
  if ((entity.attributes as { _candidate?: boolean } | null)?._candidate === true) return null;
  const rawFacts = (factsRes.data ?? []) as Array<{ id: string; predicate: string; object_text: string | null; confidence: number; observed_at: string; created_at: string; supersedes: string | null; signal_id: string | null }>;
  // Active = not pointed at by another fact's `supersedes` (subject-direction
  // fetch, so any superseding fact shares this subject and is in the set).
  // Cap at 40 active facts to bound the LLM prompt, same as the prior limit.
  const supersededIds = new Set(rawFacts.map((f) => f.supersedes).filter((x): x is string => !!x));
  const facts = rawFacts.filter((f) => !supersededIds.has(f.id)).slice(0, 40);
  // Entity types come from active is_a facts (predicate = 'is_a'). Used for
  // the prompt label below. Empty array is fine — the prompt degrades.
  const entityTypes = facts
    .filter((f) => f.predicate === 'is_a' && f.object_text)
    .map((f) => f.object_text as string);
  const ws = (wsRes.data ?? {}) as { icp?: Record<string, unknown>; about?: string; persona?: Record<string, unknown>; policy?: Record<string, any> };

  // Policy-driven scoring overrides (Phase 4). Both fall back to code defaults.
  const scoringPol = (ws.policy?.scoring ?? {}) as { weights?: Partial<ScoreWeights>; rrf_gate?: number };
  const weights = buildScoreWeights(scoringPol.weights);
  const rrfGate = typeof scoringPol.rrf_gate === 'number' ? scoringPol.rrf_gate : DEFAULT_RRF_GATE;

  // A workspace can rename the outreach lifecycle fact (policy.lifecycle
  // .stage_fact_name). The default name is already in ADMIN_PREDICATES; this
  // covers a renamed one so it is never mistaken for evidence.
  const stageFactName = (ws.policy?.lifecycle as { stage_fact_name?: string } | undefined)?.stage_fact_name;
  const substantive = (p: string) => isSubstantiveFact(p, stageFactName);

  // Fingerprint the rubric's real inputs up front. Used twice: to reuse the
  // stored judgment below, and by scoreAndAssert to drop a write that would
  // re-roll an identical question (see the race note there).
  const inputs_hash = scoreInputsHash({
    factIds: facts.filter((f) => substantive(f.predicate)).map((f) => f.id),
    attributes: entity.attributes ?? null,
    icp: ws.icp,
    about: ws.about,
    persona: ws.persona,
  });

  // Skip-when-stale guard: if a prior score_total exists and no substantive
  // fact is newer than it, the score can't have changed — bail before the
  // LLM + 4 embedding calls. Defense-in-depth; callers should already gate
  // on whether new facts were asserted this tick.
  const scoreTotalFact = facts.find((f) => f.predicate === 'score_total');
  if (scoreTotalFact) {
    const scoreTs = Date.parse(scoreTotalFact.observed_at ?? scoreTotalFact.created_at ?? '');
    const hasNewerSubstantive = facts.some((f) =>
      substantive(f.predicate) &&
      Date.parse(f.observed_at ?? f.created_at ?? '') > scoreTs,
    );
    // Also re-score when the scoring config (icp/about/persona/scoring policy)
    // changed after the last score — the scoring INPUTS changed even though no
    // new fact landed. Keyed to scoring_config_state.changed_at, NOT
    // workspaces.updated_at: updated_at bumps on every policy write (the daily
    // pipeline-status write included), which made every existing score look
    // re-scorable every day and churned full-book LLM rescores.
    const cfgChangedAt = Date.parse(
      (ws.policy?.scoring_config_state as { changed_at?: string } | undefined)?.changed_at ?? '',
    );
    const icpChangedSinceScore = Number.isFinite(cfgChangedAt) && cfgChangedAt > scoreTs;
    if (!hasNewerSubstantive && !icpChangedSinceScore) return null;
  }

  // ---- Deterministic sub-scores ----
  const evidence_depth = evidenceDepth(facts);
  const recency = recencyScore(facts, await loadSourceDates(supabase, workspace_id, facts));
  const graph = graphRes.score;

  // ---- Which dimensions could we actually measure? ----
  // Both of these come back as a fixed number that looks like a verdict but is
  // really "we don't know", so they are named for combineSubScores to drop.
  //
  // graph_proximity is the mean icp_fit of linked entities. With no edges there
  // is nothing to average and graphProximity returns 0 — indistinguishable from
  // "all its neighbours are terrible fits" in the weighted sum, which quietly
  // docked every unlinked account. edge_count tells the two apart.
  //
  // stage_match is judged from COMPANY GROUND TRUTH (team size, funding stage,
  // founded year, public/private...). The rubric instructs the model to answer
  // 0.4 when that section is empty rather than guess from prose, so on a book
  // whose accounts carry no such attributes it is a constant, not a signal.
  const groundTruth = renderGroundTruth(entity.attributes ?? {});
  const unknown_dims: string[] = [];
  if (graphRes.edge_count === 0) unknown_dims.push('graph_proximity');
  if (!groundTruth) unknown_dims.push('stage_match');

  // ---- Unchanged-inputs reuse ----
  // Past the stale guard but the rubric's inputs are byte-identical to the ones
  // behind the current score: reuse the stored judgment instead of asking again.
  // This is what stops one account being scored five times in 85 seconds when a
  // burst of signals, the 30-min rescore cron, and the enricher all land at once
  // (measured on Sudden: M6+ scored 5x with zero new evidence between any pair).
  //
  // Only the three LLM dimensions are reused. evidence_depth / recency / graph
  // are recomputed above because they are deterministic and free, so time decay
  // still moves the total without re-rolling the judgment. Those derived numbers
  // are deliberately NOT in the hash: recency changes every second, so including
  // it would make every run a cache miss and defeat the whole guard.
  const priorBreakdown = facts.find((f) => f.predicate === 'icp_fit_breakdown');
  if (priorBreakdown?.object_text) {
    try {
      const prior = JSON.parse(priorBreakdown.object_text) as Partial<ScoreBreakdown> & { inputs_hash?: string; reasoning?: string };
      if (prior.inputs_hash && prior.inputs_hash === inputs_hash
        && typeof prior.industry_match === 'number'
        && typeof prior.stage_match === 'number'
        && typeof prior.signal_strength === 'number') {
        const breakdown: ScoreBreakdown = {
          industry_match: prior.industry_match,
          stage_match: prior.stage_match,
          signal_strength: prior.signal_strength,
          evidence_depth,
          recency,
          graph_proximity: graph,
          rrf_prefilter: typeof prior.rrf_prefilter === 'number' ? prior.rrf_prefilter : 0,
          // Recomputed, not carried over from the stored breakdown: an account
          // that has since gained a contact or a ground-truth attribute becomes
          // measurable on that dimension even when the LLM judgment is reused.
          unknown_dims,
        };
        const icp_total = combineSubScores(breakdown, weights);
        return {
          icp_total,
          icp_fit: icp_total,
          breakdown,
          reasoning: prior.reasoning ?? '',
          llm_called: false,
          inputs_hash,
          reused: true,
        };
      }
    } catch { /* unparseable stored breakdown: fall through and score normally */ }
  }

  // ---- RRF pre-filter via multi-perspective embeddings ----
  // prefilterComputed distinguishes "we measured a low cosine" (a real verdict —
  // the shortcut below may act on it) from "we couldn't measure" (icp vectors
  // missing or an embed call failed). A failed measurement must NOT read as
  // cosine 0.00 — that shortcut used to silently tank a 0.9 account to ~0.35
  // with no LLM call whenever embeddings hiccuped.
  let rrf_prefilter = 0;
  let prefilterComputed = false;
  if (icpVecs) {
    const perspectiveText = buildEntityPerspectiveText(entity.name, entity.attributes ?? {}, facts);
    let entityVecs: Record<Perspective, number[]> | null = null;
    try {
      const [defV, painV, stackV, vertV] = await Promise.all([
        embed(perspectiveText.default),
        embed(perspectiveText.pain),
        embed(perspectiveText.stack),
        embed(perspectiveText.vertical),
      ]);
      entityVecs = { default: defV, pain: painV, stack: stackV, vertical: vertV };
    } catch { /* leave entityVecs null; fall through to the LLM rubric */ }

    if (entityVecs) {
      const sims = [
        cosine(entityVecs.pain, icpVecs.vectors.pain),
        cosine(entityVecs.stack, icpVecs.vectors.stack),
        cosine(entityVecs.vertical, icpVecs.vectors.vertical),
      ];
      rrf_prefilter = rrfFuse(sims);
      prefilterComputed = true;
    }
  }

  // ---- Pre-filter shortcut: when 3 embedding perspectives unanimously
  //      disagree with the ICP, more facts won't flip the answer. Skip the
  //      LLM call regardless of evidence depth. Only valid when the cosines
  //      were actually computed — on embedding failure we pay for the LLM
  //      rubric instead of writing a bogus low score.
  if (prefilterComputed && rrf_prefilter < rrfGate) {
    const breakdown: ScoreBreakdown = {
      industry_match: clamp01(rrf_prefilter),
      stage_match: 0,
      signal_strength: 0,
      evidence_depth,
      recency,
      graph_proximity: graph,
      rrf_prefilter,
      // No unknown_dims here on purpose. The zeros above are this branch's
      // verdict — three embedding perspectives unanimously disagreed with the
      // ICP — not gaps in what we know, so they belong in the mean.
    };
    const icp_total = combineSubScores(breakdown, weights);
    return {
      icp_total,
      icp_fit: icp_total,
      breakdown,
      reasoning: `Pre-filter shortcut: multi-perspective cosine ${rrf_prefilter.toFixed(2)} is below the LLM-rubric gate and evidence is thin. No LLM call.`,
      llm_called: false,
      inputs_hash,
      reused: false,
    };
  }

  // ---- LLM rubric: industry_match, stage_match, signal_strength ----
  // groundTruth was rendered above, where it decides whether stage_match is
  // measurable at all.
  const otherAttrs = renderOtherAttributes(entity.attributes ?? {});

  // What the workspace sells, pulled from the SAME config the drafter uses
  // (policy.drafter.value_props / pain_points). This anchors signal_strength to
  // "is there a reason to reach out that connects to our pitch" — the job the
  // removed value_themes keyword gate tried to do, now an LLM judgment against
  // the real value prop, no separate list to maintain. Empty = generic rubric.
  const valueProps = Array.isArray(ws.policy?.drafter?.value_props) ? (ws.policy!.drafter!.value_props as string[]) : [];
  const painPoints = Array.isArray(ws.policy?.drafter?.pain_points) ? (ws.policy!.drafter!.pain_points as string[]) : [];
  const sellBlock = (valueProps.length || painPoints.length)
    ? `\nWHAT WE SELL (judge signal_strength against THIS — a signal is strong only when it connects to a pain we solve or value we deliver, weak when it doesn't):\n${painPoints.length ? `  Pains we solve:\n${painPoints.map((p) => `    - ${p}`).join('\n')}\n` : ''}${valueProps.length ? `  Value we deliver:\n${valueProps.map((v) => `    - ${v}`).join('\n')}\n` : ''}`
    : '';

  const sysPrompt = `You score how well an account fits the workspace's ICP. You are NOT producing a single overall score; you are producing three orthogonal sub-scores on a strict rubric.

Each sub-score is in [0.0, 1.0]. Be calibrated: do not inflate scores.

GROUND TRUTH OVER INFERENCE: when the COMPANY GROUND TRUTH section gives you a hard fact (team size, funding stage, founded year, public/private), trust it over anything you might infer from FACTS prose. A 3000-person public company is not "early growth" no matter what the facts say.

DIMENSIONS:
1. industry_match — does the entity's industry / market positioning match the ICP industries described in the workspace ABOUT and ICP? Match the prose, not a single keyword.
   - 1.0: textbook match (their industry literally matches what the workspace targets)
   - 0.7: strong adjacency (close vertical, related use case)
   - 0.4: tangential (might apply, no direct fit)
   - 0.0: clear mismatch (different industry / wrong market)

2. stage_match — funding/team/scale alignment, anchored on COMPANY GROUND TRUTH.
   - 1.0: ground-truth team_size / stage / funding maps cleanly to ICP requirements
   - 0.7: close but slightly off (one stage early or late, team a bit larger/smaller than target)
   - 0.4: ambiguous — ground truth missing or partial, can't tell either way
   - 0.0: ground truth shows wrong scale (ICP wants <50-person startups, this is a 3000-person public company; or vice versa)
   When ground truth is missing, score 0.4 by default — do not guess from prose.

3. signal_strength — how *actionable* is the most recent signal that triggered this scoring, FOR WHAT WE SELL (see the WHAT WE SELL section below; if it's empty, judge against the ABOUT/ICP)?
   IMPORTANT: a directory listing or a generic mention is NOT a strong signal. A signal that doesn't connect to a pain we solve or value we deliver is weak even if it's real news. Strong signals are:
   - 1.0: hiring for the specific role we sell to, fundraising announcement, public pain statement matching what we sell, mentioning a competitor we displace
   - 0.7: clear growth signal (new round, leadership hire, customer launch)
   - 0.4: passive presence (active on a directory, listed in a database)
   - 0.0: noise (mentioned in passing in unrelated content)

REASONING: 1–2 sentences citing the SPECIFIC ground-truth fields and facts that drove each score. No filler. No template phrases.

Output JSON only:
{"industry_match": 0.0-1.0, "stage_match": 0.0-1.0, "signal_strength": 0.0-1.0, "reasoning": "<1-2 sentences>"}`;

  const userPrompt = `WORKSPACE ABOUT:
${(ws.about ?? '').slice(0, 800)}

WORKSPACE ICP:
${JSON.stringify(ws.icp ?? {}, null, 2)}
${sellBlock}
ACCOUNT: ${entity.name}${entityTypes.length ? ` (${entityTypes.join(', ')})` : ''}

COMPANY GROUND TRUTH (hard facts about the account — trust over inference):
${groundTruth || '  (none — score stage_match=0.4 by default)'}

OTHER ATTRIBUTES:
${otherAttrs || '  (none)'}

FACTS (predicate=value, conf):
${facts.length ? facts.filter((f) => !ADMIN_PREDICATES.has(f.predicate)).map((f) => `  ${f.predicate}=${f.object_text} (${f.confidence})`).join('\n') : '  (none)'}

PRE-COMPUTED SIGNALS (for context, not to copy):
  evidence_depth=${evidence_depth.toFixed(2)} (deterministic — count of substantive facts)
  recency=${recency.toFixed(2)} (deterministic — exponential decay on most recent fact)
  graph_proximity=${graph.toFixed(2)} (deterministic — mean icp_fit of linked entities)
  rrf_prefilter=${prefilterComputed ? rrf_prefilter.toFixed(2) : 'n/a (embeddings unavailable this run)'} (deterministic — multi-perspective cosine vs ICP)

Score this account on the three rubric dimensions.`;

  let parsed: { industry_match?: number; stage_match?: number; signal_strength?: number; reasoning?: string };
  try {
    const llm = await chatCompleteForWorkspace(supabase, workspace_id, {
      model: SCORE_MODEL,
      behavior: 'scoring',
      max_tokens: 350,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: userPrompt },
      ],
    });
    parsed = JSON.parse(llm.text);
  } catch {
    return null;
  }

  const breakdown: ScoreBreakdown = {
    industry_match: clamp01(typeof parsed.industry_match === 'number' ? parsed.industry_match : 0),
    stage_match: clamp01(typeof parsed.stage_match === 'number' ? parsed.stage_match : 0),
    signal_strength: clamp01(typeof parsed.signal_strength === 'number' ? parsed.signal_strength : 0),
    evidence_depth,
    recency,
    graph_proximity: graph,
    rrf_prefilter,
    unknown_dims,
  };

  const icp_total = combineSubScores(breakdown, weights);
  return {
    icp_total,
    icp_fit: icp_total,
    breakdown,
    reasoning: (parsed.reasoning ?? '').toString().slice(0, 400),
    llm_called: true,
    inputs_hash,
    reused: false,
  };
}

/**
 * The combine formula is exposed publicly so the UI / audit tools can show
 * the math instead of just the final number.
 */
export interface ScoreWeights {
  industry_match: number;
  stage_match: number;
  signal_strength: number;
  evidence_depth: number;
  recency: number;
  graph_proximity: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
  industry_match: 0.30,
  stage_match: 0.20,
  signal_strength: 0.10,
  evidence_depth: 0.20,
  recency: 0.10,
  graph_proximity: 0.10,
};

/**
 * Weighted mean over the dimensions we actually measured.
 *
 * A dimension listed in `b.unknown_dims` was not measurable for this entity —
 * we have no company ground truth to judge stage from, or the entity has no
 * graph edges at all. Those are gaps in what we know, not verdicts of poor fit,
 * so they are dropped from the mean and the remaining weights are renormalized
 * to sum to 1 instead of contributing a fabricated constant.
 *
 * The old behaviour crushed every score into one band. Worked example from the
 * Sudden book (1961 accounts, none carrying a ground-truth attribute, 92% with
 * no graph edge): stage_match came back 0.40 for every account (the rubric's own
 * "unknown" default) and graph_proximity 0.00 for every account. With weights
 * 0.20 and 0.10 that pinned 0.30 of the weight at a constant 0.08 contribution
 * and, with industry_match saturated at ~1.0 on a pre-filtered book, confined
 * every account to icp_fit 0.60-0.68. 77% landed in one decile and the ranking
 * carried no information. Renormalizing over the four measured dimensions
 * reopens the range to roughly 0.52-0.96.
 */
export function combineSubScores(b: ScoreBreakdown, weights: ScoreWeights = DEFAULT_WEIGHTS): number {
  const unknown = new Set(b.unknown_dims ?? []);
  const dims: Array<keyof ScoreWeights> = [
    'industry_match', 'stage_match', 'signal_strength', 'evidence_depth', 'recency', 'graph_proximity',
  ];
  let weighted = 0;
  let present = 0;
  for (const d of dims) {
    if (unknown.has(d)) continue;
    weighted += weights[d] * b[d];
    present += weights[d];
  }
  // Every dimension unknown, or a weights object that zeroes everything: there
  // is nothing to average, so say 0 rather than divide by zero.
  if (present <= 0) return 0;
  return clamp01(weighted / present);
}

/**
 * Merge a (possibly partial) policy.scoring.weights object onto defaults so
 * each missing key falls back to the default contribution.
 */
export function buildScoreWeights(policy?: Partial<ScoreWeights>): ScoreWeights {
  return { ...DEFAULT_WEIGHTS, ...(policy ?? {}) };
}

// ---------- contact scoring ----------
//
// A contact is scored on person-as-entry-point fit, NOT company fit. It reuses
// the ScoreBreakdown struct with three slots remapped: industry_match=persona
// match, stage_match=decision power, graph_proximity=parent account fit (the
// contact's only graph edge is works_at->account, so graphProximity returns the
// account's icp_fit — a one-way discount, contact<-account, never the reverse).
// Stored under `contact_score`, never `icp_fit`, so it stays invisible to the
// account distribution and graph.ts (which only reads icp_fit).
//
// Deterministic by design: seniority/role rules instead of an LLM. Cheaper,
// predictable, and degrades cleanly when personas are unset. Semantic persona
// matching via LLM is a later enhancement behind this same interface.

export const DEFAULT_CONTACT_WEIGHTS: ScoreWeights = {
  industry_match: 0.30,   // persona_match
  stage_match: 0.20,      // decision_power
  signal_strength: 0.15,  // contact-level signal
  evidence_depth: 0.10,
  recency: 0.05,
  graph_proximity: 0.20,  // account_fit
};

interface ContactWeightsPolicy {
  persona_match?: number;
  decision_power?: number;
  signal_strength?: number;
  evidence_depth?: number;
  recency?: number;
  account_fit?: number;
}

export function buildContactWeights(policy?: ContactWeightsPolicy): ScoreWeights {
  return {
    industry_match: policy?.persona_match ?? DEFAULT_CONTACT_WEIGHTS.industry_match,
    stage_match: policy?.decision_power ?? DEFAULT_CONTACT_WEIGHTS.stage_match,
    signal_strength: policy?.signal_strength ?? DEFAULT_CONTACT_WEIGHTS.signal_strength,
    evidence_depth: policy?.evidence_depth ?? DEFAULT_CONTACT_WEIGHTS.evidence_depth,
    recency: policy?.recency ?? DEFAULT_CONTACT_WEIGHTS.recency,
    graph_proximity: policy?.account_fit ?? DEFAULT_CONTACT_WEIGHTS.graph_proximity,
  };
}

/** Decision power from a role/title string. Founder/CEO at the top, IC at the bottom. */
export function decisionPower(roleText: string): number {
  const r = roleText.toLowerCase();
  if (/\b(founder|ceo|chief executive|owner)\b/.test(r)) return 1.0;
  if (/co-?founder|cto|cpo|coo|cfo|cmo|chief|president/.test(r)) return 0.9;
  if (/\bvp\b|vice president|head of/.test(r)) return 0.75;
  if (/director/.test(r)) return 0.6;
  if (/lead|manager|principal|staff/.test(r)) return 0.45;
  return 0.3; // IC / unknown
}

/** Persona match: role vs workspace target_roles patterns. Empty config falls
 *  back to decision power as the proxy (no vertical assumption). */
export function personaMatch(roleText: string, targetRoles: string[], decisionPwr: number): number {
  if (!targetRoles.length) return decisionPwr;
  for (const pat of targetRoles) {
    try {
      if (new RegExp(pat, 'i').test(roleText)) return 1.0;
    } catch {
      if (roleText.toLowerCase().includes(pat.toLowerCase())) return 1.0;
    }
  }
  return 0.2; // personas configured but this role doesn't match
}

export async function scoreContact(
  supabase: SupabaseClient,
  workspace_id: string,
  entity_id: string,
): Promise<EntityScore | null> {
  const [entRes, factsRes, wsRes, graphRes] = await Promise.all([
    supabase.from('entities').select('id, name, attributes').eq('id', entity_id).maybeSingle(),
    supabase.from('facts').select('id, predicate, object_text, confidence, observed_at, created_at, supersedes')
      .eq('workspace_id', workspace_id).eq('subject_entity', entity_id)
      .order('observed_at', { ascending: false }),
    supabase.from('workspaces').select('policy, about').eq('id', workspace_id).maybeSingle(),
    graphProximity(supabase, workspace_id, entity_id),
  ]);
  if (!entRes.data) return null;

  const rawFacts = (factsRes.data ?? []) as Array<{ id: string; predicate: string; object_text: string | null; confidence: number; observed_at: string; created_at: string; supersedes: string | null }>;
  const supersededIds = new Set(rawFacts.map((f) => f.supersedes).filter((x): x is string => !!x));
  const facts = rawFacts.filter((f) => !supersededIds.has(f.id));

  // Skip-when-stale: if a contact_score exists and nothing substantive is newer,
  // the score can't have changed. Cheap guard against cron churn.
  const prior = facts.find((f) => f.predicate === 'contact_score');
  if (prior) {
    const ts = Date.parse(prior.observed_at ?? prior.created_at ?? '');
    const newer = facts.some((f) => !ADMIN_PREDICATES.has(f.predicate) && Date.parse(f.observed_at ?? f.created_at ?? '') > ts);
    // Re-score too when the scoring config changed after the last score (same
    // scoring_config_state key as scoreEntity — see comment there for why this
    // is not workspaces.updated_at).
    const cfgAt = Date.parse(
      ((wsRes.data as { policy?: { scoring_config_state?: { changed_at?: string } } } | null)
        ?.policy?.scoring_config_state?.changed_at) ?? '',
    );
    const cfgChanged = Number.isFinite(cfgAt) && cfgAt > ts;
    if (!newer && !cfgChanged) return null;
  }

  const ws = (wsRes.data ?? {}) as { policy?: Record<string, any>; about?: string };
  const targetRoles = Array.isArray(ws.policy?.personas?.target_roles) ? ws.policy!.personas.target_roles as string[] : [];
  const weights = buildContactWeights(ws.policy?.contact_scoring?.weights);

  // Role text from role/title/seniority facts.
  const roleText = facts
    .filter((f) => ['role', 'title', 'seniority'].includes(f.predicate) && f.object_text)
    .map((f) => f.object_text as string)
    .join(' ');

  const dp = decisionPower(roleText);
  const persona = personaMatch(roleText, targetRoles, dp);
  const evidence_depth = evidenceDepth(facts);
  const recency = recencyScore(facts);
  const account_fit = graphRes.score; // mean neighbor icp_fit == parent account fit

  // Contact-level signal. Most contacts are names-only and have no content to
  // judge — those sit passive (0.2) with NO LLM call, keeping token cost ~zero.
  // When the contact has real content (a social post, a quote, a job-change blurb
  // enriched onto it), a tiny LLM call rates how strongly it signals buying
  // intent for this workspace's pitch. The LLM fires ONLY when content exists.
  const SEED = new Set(['role', 'title', 'seniority', 'works_at', 'linkedin_url', 'prospect_id', 'email', 'is_a']);
  const contentFacts = facts.filter((f) =>
    !ADMIN_PREDICATES.has(f.predicate) && !SEED.has(f.predicate) && (f.object_text ?? '').trim().length >= 40,
  );
  let signal_strength = 0.2;
  let llm_called = false;
  if (contentFacts.length) {
    const content = contentFacts.map((f) => `${f.predicate}: ${f.object_text}`).join('\n').slice(0, 600);
    signal_strength = await rateContactSignal(supabase, workspace_id, ws.about ?? '', content);
    llm_called = true;
  }

  const breakdown: ScoreBreakdown = {
    industry_match: persona,
    stage_match: dp,
    signal_strength,
    evidence_depth,
    recency,
    graph_proximity: account_fit,
    rrf_prefilter: 0,
  };
  const total = combineSubScores(breakdown, weights);
  return {
    icp_total: total,
    icp_fit: total, // returned for shape parity; NOT written to DB for contacts
    breakdown,
    reasoning: `Contact score ${total.toFixed(2)}: persona ${persona.toFixed(2)}, decision_power ${dp.toFixed(2)} (${roleText || 'no role'}), signal ${signal_strength.toFixed(2)}${llm_called ? ' (llm)' : ''}, account_fit ${account_fit.toFixed(2)}.`,
    llm_called,
    // Contacts are scored on a different rubric and are not part of the
    // unchanged-inputs guard; an empty hash opts them out of it.
    inputs_hash: '',
    reused: false,
  };
}

/**
 * Rate a contact's content signal 0..1 for buying intent vs the workspace pitch.
 * One tiny LLM call (max ~6 tokens out). Called only when there is content to
 * judge. Falls back to a neutral 0.4 on any failure so scoring never breaks.
 */
async function rateContactSignal(
  supabase: SupabaseClient,
  workspace_id: string,
  about: string,
  content: string,
): Promise<number> {
  try {
    // SCORE_MODEL is a reasoning model: it needs headroom to finish and a JSON
    // response_format to emit a parseable answer (a bare "give me a number" with
    // a tiny budget returns empty — all tokens spent reasoning). ~150 tokens is
    // enough to finish; this only fires on content-bearing contacts, so the
    // amortized cost stays low.
    const llm = await chatCompleteForWorkspace(supabase, workspace_id, {
      model: SCORE_MODEL,
      behavior: 'scoring',
      max_tokens: 150,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `Output JSON {"score": n} where n in [0,1] rates how strongly the text signals the person would buy from a company whose offering is: "${(about || 'B2B software').slice(0, 300)}". 1.0 = explicit pain or buying trigger we solve; 0.5 = relevant context; 0.0 = irrelevant.`,
        },
        { role: 'user', content },
      ],
    });
    const parsed = JSON.parse(llm.text) as { score?: number };
    const n = typeof parsed.score === 'number' ? parsed.score : NaN;
    return Number.isFinite(n) ? clamp01(n) : 0.4;
  } catch {
    return 0.4;
  }
}

// ---------- assertion ----------

export async function scoreAndAssert(
  supabase: SupabaseClient,
  actor: { workspace_id: string; actor_kind: 'agent' | 'user' | 'system'; actor_id: string },
  entity_id: string,
): Promise<EntityScore | null> {
  // ICP fit is an account-level property. A contact/person has no industry_match
  // or stage_match, so scoring them produces a meaningless number that pollutes
  // the distribution. Gate at the write path so every caller is covered.
  // Workspace policy.scorable_types lists which is_a values are scoreable;
  // default to ['account'] for back-compat with the old kind enum.
  const [typeRes, polRes] = await Promise.all([
    supabase.from('facts').select('id, object_text, supersedes')
      .eq('workspace_id', actor.workspace_id)
      .eq('subject_entity', entity_id)
      .eq('predicate', 'is_a'),
    supabase.from('workspaces').select('policy').eq('id', actor.workspace_id).maybeSingle(),
  ]);
  const typeRows = (typeRes.data ?? []) as Array<{ id: string; object_text: string | null; supersedes: string | null }>;
  const typeSuperseded = new Set(typeRows.map((r) => r.supersedes).filter((x): x is string => !!x));
  const entityTypes = typeRows
    .filter((r) => !typeSuperseded.has(r.id))
    .map((r) => r.object_text)
    .filter((s): s is string => !!s);
  const scorableTypes: string[] = Array.isArray(polRes.data?.policy?.scorable_types)
    ? polRes.data!.policy.scorable_types as string[]
    : ['account'];
  if (!entityTypes.some((t) => scorableTypes.includes(t))) return null;

  // Respect active dropped_until: re-scoring a dropped entity wastes LLM calls,
  // pollutes the score_distribution sweep, and gives the operator a fresh
  // score that contradicts the drop decision. action_selector already
  // short-circuits at the action layer; this is the same check, earlier.
  const dropRes = await supabase.from('facts')
    .select('id, object_text, supersedes')
    .eq('workspace_id', actor.workspace_id)
    .eq('subject_entity', entity_id)
    .eq('predicate', 'dropped_until')
    .order('observed_at', { ascending: false });
  const dropRows = (dropRes.data ?? []) as Array<{ id: string; object_text: string | null; supersedes: string | null }>;
  const dropSuperseded = new Set(dropRows.map((r) => r.supersedes).filter((x): x is string => !!x));
  const dropUntil = dropRows.find((r) => !dropSuperseded.has(r.id))?.object_text ?? null;
  if (dropUntil) {
    const t = Date.parse(dropUntil);
    if (Number.isFinite(t) && t > Date.now()) return null;
  }

  // Dispatch by entity type. Contacts are scored on persona/decision-power and
  // stored under `contact_score`; accounts keep the icp_fit/score_total path.
  // Keeping icp_fit account-only is what stops contacts polluting account scores
  // and graph proximity (graph.ts reads only icp_fit).
  const isContact = entityTypes.includes('contact');
  const score = isContact
    ? await scoreContact(supabase, actor.workspace_id, entity_id)
    : await scoreEntity(supabase, actor.workspace_id, entity_id);
  if (!score) return null;

  // ---- Write-time race check ----
  // Two runs can both pass scoreEntity's read-time guards: each loads facts
  // before the other writes its score, so neither sees the other. Re-read the
  // CURRENT breakdown here, after the scoring work, and drop this write if a
  // concurrent run already recorded a score from identical inputs. Whoever
  // finishes first wins and the loser discards a duplicate answer instead of
  // overwriting a good score with a re-rolled one.
  //
  // This is the part that does not need a lock: both runs compute the same
  // fingerprint, so it also covers callers outside agentRun's per-entity
  // serialization (the 30-min rescore cron, the score_entity tool, contacts.ts).
  if (score.inputs_hash) {
    const bdRows = await supabase.from('facts').select('id, object_text, supersedes, observed_at')
      .eq('workspace_id', actor.workspace_id)
      .eq('subject_entity', entity_id)
      .eq('predicate', 'icp_fit_breakdown')
      .order('observed_at', { ascending: false });
    const rows = (bdRows.data ?? []) as Array<{ id: string; object_text: string | null; supersedes: string | null }>;
    const pointedTo = new Set(rows.map((r) => r.supersedes).filter((x): x is string => !!x));
    const current = rows.find((r) => !pointedTo.has(r.id));
    if (current?.object_text) {
      try {
        const stored = JSON.parse(current.object_text) as { inputs_hash?: string };
        if (stored.inputs_hash === score.inputs_hash) return { ...score, reused: true };
      } catch { /* unparseable: fall through and write */ }
    }
  }

  // Breakdown JSON as a separate fact for human / UI consumption. Supersede the
  // prior breakdown instead of asserting fresh — the JSON differs every rescore
  // (content-hash never matches), so a plain assert_fact leaked a new row per
  // tick (599 active across ~222 entities before this fix). Same find-current-
  // then-supersede pattern as the numeric score_* fields below.
  //
  // Written BEFORE the sub-scores because it is the row that carries
  // inputs_hash, and that hash is how a concurrent run knows this evidence has
  // already been answered. Writing it last left a window nine round trips wide
  // in which a second run saw no hash and duplicated the whole write (measured:
  // 5 simultaneous runs produced 2 score rows). First shrinks it to one.
  try {
    // Persist the plain-language reasoning alongside the numeric breakdown so
    // the entity page can explain the score in words, not just sub-scores.
    // inputs_hash rides along so the next run can tell "same evidence, don't ask
    // again" from "new evidence, re-score". Empty for contacts (own rubric).
    const breakdownText = JSON.stringify({
      ...score.breakdown,
      reasoning: score.reasoning,
      ...(score.inputs_hash ? { inputs_hash: score.inputs_hash } : {}),
    });
    const allRows = await supabase.from('facts').select('id, supersedes, observed_at')
      .eq('workspace_id', actor.workspace_id)
      .eq('subject_entity', entity_id)
      .eq('predicate', 'icp_fit_breakdown')
      .order('observed_at', { ascending: false });
    const rows = (allRows.data ?? []) as Array<{ id: string; supersedes: string | null; observed_at: string }>;
    const pointedTo = new Set(rows.map((r) => r.supersedes).filter((x): x is string => !!x));
    const current = rows.find((r) => !pointedTo.has(r.id)) ?? null;
    await act(supabase, actor, {
      tool: current ? 'supersede_fact' : 'assert_fact',
      args: {
        subject_entity: entity_id, predicate: 'icp_fit_breakdown',
        object_text: breakdownText, confidence: 0.85,
        ...(current ? { supersedes: current.id } : {}),
      },
    });
  } catch { /* non-fatal */ }

  // Sub-scores asserted as their own facts for audit + future calibration.
  // Each one supersedes the prior version. We do this in a loop so a write
  // failure on one doesn't abort the rest. Contacts reuse the score_* sub
  // predicates (remapped meanings) but write `contact_score` as the total and
  // never `icp_fit`.
  const subScores: Array<{ predicate: string; value: number }> = [
    { predicate: 'score_industry_match', value: score.breakdown.industry_match },
    { predicate: 'score_stage_match', value: score.breakdown.stage_match },
    { predicate: 'score_signal_strength', value: score.breakdown.signal_strength },
    { predicate: 'score_evidence_depth', value: score.breakdown.evidence_depth },
    { predicate: 'score_recency', value: score.breakdown.recency },
    { predicate: 'score_graph_proximity', value: score.breakdown.graph_proximity },
    { predicate: isContact ? 'contact_score' : 'score_total', value: score.icp_total },
    ...(isContact ? [] : [{ predicate: 'icp_fit', value: score.icp_total }]), // backward compat, account-only
  ];
  for (const s of subScores) {
    // The CURRENT fact is the one NOT superseded by any other row.
    // supersede_fact writes the new row with supersedes = <old id>, so
    // `supersedes is null` returns the stale ORIGINAL — superseding that forks
    // the chain. Fetch all rows for the predicate and pick the not-pointed-to
    // one (newest by observed_at among any that survive a prior leak).
    const allRows = await supabase.from('facts').select('id, object_text, supersedes, observed_at')
      .eq('workspace_id', actor.workspace_id)
      .eq('subject_entity', entity_id)
      .eq('predicate', s.predicate)
      .order('observed_at', { ascending: false });
    const rows = (allRows.data ?? []) as Array<{ id: string; object_text: string | null; supersedes: string | null; observed_at: string }>;
    const pointedTo = new Set(rows.map((r) => r.supersedes).filter((x): x is string => !!x));
    const existing = { data: rows.find((r) => !pointedTo.has(r.id)) ?? null };
    const newText = s.value.toFixed(2);
    // Always write — even when the value is unchanged — so observed_at refreshes
    // and the sweep's score_signal_coupling check can see that the scorer ran.
    // scoreEntity (LLM + embeddings) already executed; this is just 8 row writes.
    try {
      if (existing.data) {
        await act(supabase, actor, {
          tool: 'supersede_fact',
          args: {
            subject_entity: entity_id, predicate: s.predicate,
            object_text: newText, confidence: 0.9,
            supersedes: existing.data.id,
          },
        });
      } else {
        await act(supabase, actor, {
          tool: 'assert_fact',
          args: { subject_entity: entity_id, predicate: s.predicate, object_text: newText, confidence: 0.9 },
        });
      }
    } catch {
      // skip; next rescore tick retries
    }
  }

  return score;
}
