/**
 * The scoring FORMULA and its explanation. No database, no LLM, no node builtins.
 *
 * Split out of scoring.ts so the UI can import it. scoring.ts imports
 * `node:crypto` for scoreInputsHash, and webpack cannot resolve a `node:` scheme
 * in a client bundle — so a client component that wanted `explainScore` pulled
 * the whole server module in behind it and the production build failed with
 * `UnhandledSchemeError: Reading from "node:crypto"`. The Render deploy failed
 * on exactly that from 2026-08-14 onward, silently, which is how the cloud ended
 * up running a build older than the anchor work.
 *
 * Everything here is pure, so the rule for what belongs is simple: if it needs a
 * SupabaseClient, an embedding, or a hash, it stays in scoring.ts.
 *
 * scoring.ts re-exports all of it, so every existing import site is unchanged.
 */

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
   * contributed nothing to icp_fit. Three cases produce it today: no company
   * ground truth to judge stage_match from, no scored neighbour so
   * graph_proximity has nothing to average, and no dated source behind any fact
   * so recency has no age to measure.
   *
   * The filled-in number for such a dimension is a placeholder 0, NOT a
   * verdict. Anything reading the sub-scores must consult this list first —
   * `explainScore` below is the supported way to do that, and reading the
   * `score_*` fact rows alone cannot: they carry the placeholder and not this
   * list. Use `breakdownFromFacts` to rebuild a breakdown that still knows.
   */
  unknown_dims?: string[];
  /**
   * Fact ids that fed a dimension's number, when known - lets the UI cite the
   * specific facts behind a score move instead of just showing the delta.
   * Only graph_proximity is populated today: it's a plain mean over neighbor
   * icp_fit facts, so the contributing ids are known outright. The LLM-judged
   * dimensions (industry_match/stage_match/signal_strength) don't yet capture
   * which facts the rubric leaned on.
   */
  evidence_fact_ids?: { graph_proximity?: string[] };
  /**
   * Set when a policy.drafter.out_of_scope condition matched: the condition
   * text, followed by the fact that triggered it. Its presence means icp_total
   * was vetoed to 0 and the sub-scores above are evidence only — they describe
   * an account we still cannot serve. Absent on every account that passed.
   */
  out_of_scope?: string;
}

/** Clamp to [0,1]. Shared with scoring.ts, which imports it back from here. */
export function clamp01(x: number): number { return Math.max(0, Math.min(1, x)); }

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

/**
 * The dimensions, in display order. One list, so the combine formula and every
 * explanation of it can never drift apart.
 */
export const SCORE_DIMS: Array<keyof ScoreWeights> = [
  'industry_match', 'stage_match', 'signal_strength', 'evidence_depth', 'recency', 'graph_proximity',
];

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
  let weighted = 0;
  let present = 0;
  for (const d of SCORE_DIMS) {
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

// ---------- explaining the number ----------
//
// combineSubScores returns one number and throws away the arithmetic that made
// it. Anything that wanted to say WHY a score is what it is had to re-derive
// that arithmetic, and the re-derivations were wrong: the Today page picked the
// dimension with the largest raw move and called it the cause, which ignores
// weight (a 0.08 move on a 0.10-weight dimension is worth 0.008 of the total)
// and cannot see the renormalize rule at all. Live case: Wedotv fell 0.94 ->
// 0.81 and the page blamed freshness, which accounted for 0.008 of the 0.13.
//
// So the explanation ships with the formula, in the same file, sharing SCORE_DIMS.

export interface ScoreContribution {
  key: keyof ScoreWeights;
  /** The sub-score. A placeholder 0 when `measured` is false — not a verdict. */
  value: number;
  /** False when the dimension is in unknown_dims and contributes nothing. */
  measured: boolean;
  /** The configured weight, before the renormalize. */
  weight: number;
  /** weight / measured_weight, so the measured weights sum to 1. 0 when unmeasured. */
  effective_weight: number;
  /** effective_weight × value. These sum to the total. */
  contribution: number;
}

export interface ScoreExplanation {
  /** What icp_fit actually is: 0 when vetoed, whatever the dimensions say otherwise. */
  total: number;
  /** The weighted mean of the dimensions, before any veto. Equals `total` when not vetoed. */
  dimension_total: number;
  /** The renormalizing denominator: the weights of the dimensions we could measure. */
  measured_weight: number;
  /** Set when a policy.drafter.out_of_scope condition matched and forced the total to 0. */
  out_of_scope?: string;
  contributions: ScoreContribution[];
}

/**
 * icp_fit as stored: an out_of_scope veto forces it to 0 no matter what the
 * dimensions say (see scoreEntity), so any explanation that only adds up
 * dimensions describes a number the account does not have.
 */
function effectiveTotal(b: ScoreBreakdown, weights: ScoreWeights): number {
  if (typeof b.out_of_scope === 'string' && b.out_of_scope.trim()) return 0;
  return combineSubScores(b, weights);
}

/**
 * The same number combineSubScores returns, plus the arithmetic behind it.
 *
 * `contributions` sums to `dimension_total`. That holds for any weights whose
 * measured mean lands inside [0,1], which is every real weights object:
 * sub-scores are in [0,1] and weights are non-negative. combineSubScores
 * clamps, so a weights object contrived to push the mean outside that range
 * would leave the sum above it — the clamp is the difference, not a bug in the
 * split.
 *
 * `total` is what the account actually scores, so it is 0 on a vetoed account
 * whose dimensions add to something else. Show `out_of_scope` alongside the
 * contributions or the table will not appear to reconcile.
 */
export function explainScore(b: ScoreBreakdown, weights: ScoreWeights = DEFAULT_WEIGHTS): ScoreExplanation {
  const unknown = new Set(b.unknown_dims ?? []);
  let measured_weight = 0;
  for (const d of SCORE_DIMS) if (!unknown.has(d)) measured_weight += weights[d];

  const contributions = SCORE_DIMS.map((d): ScoreContribution => {
    const measured = !unknown.has(d);
    const effective_weight = measured && measured_weight > 0 ? weights[d] / measured_weight : 0;
    return {
      key: d,
      value: b[d],
      measured,
      weight: weights[d],
      effective_weight,
      contribution: effective_weight * b[d],
    };
  });

  const veto = typeof b.out_of_scope === 'string' && b.out_of_scope.trim() ? b.out_of_scope : undefined;
  return {
    total: effectiveTotal(b, weights),
    dimension_total: combineSubScores(b, weights),
    measured_weight,
    ...(veto ? { out_of_scope: veto } : {}),
    contributions,
  };
}

export type ScoreMoveCause =
  | 'started_counting' | 'stopped_counting' | 'value_changed'
  /** An out_of_scope condition stopped matching, so the account is scored again. */
  | 'veto_lifted'
  /** An out_of_scope condition matched, forcing the total to 0 whatever the dimensions say. */
  | 'vetoed';

/** The key a veto line carries, since it is not one of the weighted dimensions. */
export const VETO_KEY = 'out_of_scope';

export interface ScoreMoveLine {
  /** A dimension name, or VETO_KEY. */
  key: string;
  cause: ScoreMoveCause;
  /** null when the dimension was not counted before. */
  prev_value: number | null;
  /** null when the dimension is not counted now. */
  next_value: number | null;
  /** Points of the total delta this change is responsible for. */
  effect: number;
  /** The condition text, on a veto line. */
  note?: string;
}

export interface ScoreMove {
  total_prev: number;
  total_next: number;
  delta: number;
  lines: ScoreMoveLine[];
}

/**
 * Why the score moved, in points that add up.
 *
 * `lines` sums to `delta` exactly, with no residual, because it is built as a
 * walk rather than an attribution: start at `prev`, change one dimension at a
 * time until you reach `next`, and record what the total did at each step. The
 * steps telescope, so the sum is the delta by construction.
 *
 * Two things make this different from diffing the sub-scores, and both were
 * live bugs on the Today page:
 *
 *   1. A dimension can move the total without its number changing. When
 *      graph_proximity left unknown_dims for Wedotv it read 0.00 before and
 *      0.00 after, but the renormalizing denominator went 0.70 -> 0.80 and
 *      diluted every other dimension, which is the whole -0.127. A diff of the
 *      numbers sees nothing.
 *   2. A dimension whose number went UP can lower the total. Go3's freshness
 *      became measurable at 0.32, well under its 0.90 average, so counting it
 *      cost 0.083. Displayed as "0.00 -> 0.32" that reads as an improvement.
 *
 * Ordering: counted-set changes run first, since they move the denominator that
 * every later step divides by, then value changes. The set steps are therefore
 * order-dependent (the order is SCORE_DIMS, fixed); the value steps are not,
 * because by then the denominator is settled and each is exactly
 * weight/measured_weight × the value change.
 */
export function explainScoreChange(
  prev: ScoreBreakdown,
  next: ScoreBreakdown,
  weights: ScoreWeights = DEFAULT_WEIGHTS,
): ScoreMove {
  const prevUnknown = new Set(prev.unknown_dims ?? []);
  const nextUnknown = new Set(next.unknown_dims ?? []);
  const prevVeto = typeof prev.out_of_scope === 'string' && prev.out_of_scope.trim() ? prev.out_of_scope : null;
  const nextVeto = typeof next.out_of_scope === 'string' && next.out_of_scope.trim() ? next.out_of_scope : null;

  let cursor: ScoreBreakdown = { ...prev, unknown_dims: [...(prev.unknown_dims ?? [])] };
  const total_prev = effectiveTotal(cursor, weights);
  let running = total_prev;
  const lines: ScoreMoveLine[] = [];

  const step = (mutated: ScoreBreakdown, line: Omit<ScoreMoveLine, 'effect'>) => {
    cursor = mutated;
    const after = effectiveTotal(cursor, weights);
    lines.push({ ...line, effect: after - running });
    running = after;
  };

  // Pass 0: a veto being lifted, first, so the dimension steps below are
  // visible instead of being flattened against a total pinned at 0. This is the
  // biggest single move a score can make and it is invisible in the sub-scores:
  // Telesat read 0.00 -> 0.39 while industry_match and signal_strength both
  // FELL, because the whole move was the veto coming off.
  if (prevVeto && !nextVeto) {
    const { out_of_scope: _drop, ...lifted } = cursor;
    step(lifted as ScoreBreakdown, {
      key: VETO_KEY, cause: 'veto_lifted', prev_value: null, next_value: null, note: prevVeto,
    });
  }

  // Pass 1: dimensions that started or stopped counting.
  for (const d of SCORE_DIMS) {
    const was = !prevUnknown.has(d);
    const now = !nextUnknown.has(d);
    if (was === now) continue;
    if (now) {
      // Nothing meaningful was stored for it before (the old number is the
      // placeholder 0), so it enters at the value it has now.
      const entered: ScoreBreakdown = {
        ...cursor,
        unknown_dims: (cursor.unknown_dims ?? []).filter((x) => x !== d),
      };
      entered[d] = next[d];
      step(entered, { key: d, cause: 'started_counting', prev_value: null, next_value: next[d] });
    } else {
      step(
        { ...cursor, unknown_dims: [...(cursor.unknown_dims ?? []), d] },
        { key: d, cause: 'stopped_counting', prev_value: prev[d], next_value: null },
      );
    }
  }

  // Pass 2: dimensions counted in both, whose value moved.
  for (const d of SCORE_DIMS) {
    if (prevUnknown.has(d) || nextUnknown.has(d)) continue;
    if (Math.abs(next[d] - prev[d]) < 1e-9) continue;
    const moved: ScoreBreakdown = { ...cursor };
    moved[d] = next[d];
    step(moved, { key: d, cause: 'value_changed', prev_value: prev[d], next_value: next[d] });
  }

  // Pass 3: a veto landing, last, so it absorbs the drop to 0 rather than
  // hiding the dimension moves underneath it.
  if (nextVeto && !prevVeto) {
    step({ ...cursor, out_of_scope: nextVeto }, {
      key: VETO_KEY, cause: 'vetoed', prev_value: null, next_value: null, note: nextVeto,
    });
  }

  // `running` walked to next's measured set with next's values in every counted
  // slot and next's veto state, so it equals effectiveTotal(next) term for term.
  return { total_prev, total_next: running, delta: running - total_prev, lines };
}

/**
 * Turn an already-parsed `icp_fit_breakdown` payload into a ScoreBreakdown,
 * or null when it is not one. Callers that hold the parsed JSON (the Today page
 * reads it in bulk) use this directly; breakdownFromFacts uses it after
 * pulling the fact. Either way the unknown_dims list survives the trip, which
 * is the whole point.
 */
export function coerceBreakdown(j: unknown): ScoreBreakdown | null {
  if (!j || typeof j !== 'object') return null;
  const o = j as Partial<ScoreBreakdown>;
  if (!SCORE_DIMS.every((d) => typeof o[d] === 'number')) return null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    industry_match: num(o.industry_match),
    stage_match: num(o.stage_match),
    signal_strength: num(o.signal_strength),
    evidence_depth: num(o.evidence_depth),
    recency: num(o.recency),
    graph_proximity: num(o.graph_proximity),
    rrf_prefilter: num(o.rrf_prefilter),
    ...(Array.isArray(o.unknown_dims) ? { unknown_dims: o.unknown_dims } : {}),
    ...(o.evidence_fact_ids ? { evidence_fact_ids: o.evidence_fact_ids } : {}),
    ...(typeof o.out_of_scope === 'string' ? { out_of_scope: o.out_of_scope } : {}),
  };
}

/**
 * Rebuild a breakdown from an entity's facts, WITH its unknown_dims intact.
 *
 * The `score_*` fact rows store a placeholder 0 for a dimension that could not
 * be measured and carry no marker saying so, so reading them alone turns "we
 * have no scored connections" into "its connections are a terrible fit". Three
 * call sites each hand-rolled that read and each got it wrong; this is the one
 * they should share.
 *
 * The `icp_fit_breakdown` fact is the real source: scoreEntity writes it on
 * every run with unknown_dims inside. The `score_*` rows are the fallback for
 * entities scored before that fact existed, and they cannot recover which
 * dimensions were unmeasured — `source` says which you got.
 */
export function breakdownFromFacts(
  facts: Array<{ predicate: string; object_text: string | null }>,
): { breakdown: ScoreBreakdown; source: 'breakdown' | 'score_facts' } | null {
  const blob = facts.find((f) => f.predicate === 'icp_fit_breakdown')?.object_text;
  if (blob) {
    try {
      const parsed = coerceBreakdown(JSON.parse(blob));
      if (parsed) return { source: 'breakdown', breakdown: parsed };
    } catch { /* unparseable: fall through to the score_* rows */ }
  }

  const read = (p: string) => {
    const f = facts.find((x) => x.predicate === p);
    const v = f ? parseFloat(f.object_text ?? '') : NaN;
    return Number.isFinite(v) ? v : null;
  };
  const vals = SCORE_DIMS.map((d) => read(`score_${d}`));
  if (vals.every((v) => v === null)) return null;
  return {
    source: 'score_facts',
    breakdown: {
      industry_match: vals[0] ?? 0,
      stage_match: vals[1] ?? 0,
      signal_strength: vals[2] ?? 0,
      evidence_depth: vals[3] ?? 0,
      recency: vals[4] ?? 0,
      graph_proximity: vals[5] ?? 0,
      rrf_prefilter: 0,
    },
  };
}
