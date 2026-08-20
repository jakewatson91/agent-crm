/**
 * Shared "what counts as a human-visible fact" + score-card derivation logic.
 * One definition so the full entity page and the drawer's compact entity view
 * always agree on what to show and hide — see labels.ts for the underlying
 * code-detection rules this builds on.
 */
import { breakdownFromFacts, explainScore, type ScoreWeights } from '@agent-crm/tools/score_explain';
import { humanizePredicate, looksLikeCode } from './labels';
import { SCORE_DIMENSIONS } from './score_labels';

export interface FactLike {
  id: string;
  predicate: string;
  object_text: string | null;
  object_entity: string | null;
  object_entity_name?: string | null;
  confidence: number;
  observed_at: string;
}

export const FAMILY_LABEL: Record<string, string> = {
  firmographics: 'Firmographics',
  scoring:       'Scoring',
  engagement:    'Engagement',
  other:         'Other',
};

const FAMILY_ORDER = ['firmographics', 'scoring', 'engagement', 'other'];

// Renders a fact predicate as a human relationship label (edges in the graph,
// not the plain field label — "advises", "works at", "investor of").
export function predicateLabel(predicate: string): string {
  if (predicate === 'works_at') return 'works at';
  if (predicate === 'advises') return 'advises';
  const m = predicate.match(/^is_(.+)_of$/);
  if (m && m[1]) return m[1].replace(/_/g, ' ');
  return predicate.replace(/_/g, ' ');
}

// Score-related facts get their own clean card, not a row in the facts list.
export function isScoreFact(p: string): boolean {
  return p === 'icp_fit' || p === 'score_total' || p === 'icp_fit_breakdown' || p === 'contact_score' || p.startsWith('score_');
}

// Facts a human can't read: the type fact (shown as a badge), the score
// internals (shown in the score card), raw JSON / error blobs, and bare codes.
// Entity-reference facts always stay — they render as a link.
export function isMachineFact(f: { predicate: string; object_text: string | null; object_entity: string | null }): boolean {
  if (f.object_entity) return false;
  if (f.predicate === 'is_a') return true;
  if (isScoreFact(f.predicate)) return true;
  const v = (f.object_text ?? '').trim();
  if (v.startsWith('{') || v.startsWith('[')) return true;
  if (/^error[:\s]/i.test(v)) return true;
  if (looksLikeCode(f.predicate, f.object_text)) return true;
  return false;
}

/**
 * Human facts view: drop machine facts and skip families that empty out,
 * sorted into the same family order everywhere. Everything hidden stays in
 * the audit stream + the API.
 */
export function groupVisibleFacts<T extends FactLike>(
  currentFacts: Record<string, T[]>,
): { visibleFacts: Record<string, T[]>; families: string[] } {
  const visibleFacts: Record<string, T[]> = {};
  for (const [fam, arr] of Object.entries(currentFacts)) {
    const keep = arr.filter((f) => !isMachineFact(f));
    if (keep.length) visibleFacts[fam] = keep;
  }
  const families = Object.keys(visibleFacts).sort((a, b) => FAMILY_ORDER.indexOf(a) - FAMILY_ORDER.indexOf(b));
  return { visibleFacts, families };
}

export interface ScoreComponent {
  key: string;
  /** The score_* fact behind this row, for the provenance trace. */
  id: string | null;
  label: string;
  help: string | null;
  value: number;
  /** False when the dimension was dropped from the average, not scored low. */
  measured: boolean;
  /** Why it could not be measured, when it wasn't. */
  unmeasuredReason: string | null;
  /** The dimension's share of the average after the renormalize. */
  effectiveWeight: number;
  /** effectiveWeight × value. The components' contributions sum to the score. */
  contribution: number;
}

export interface ScoreCard {
  score: number | null;
  scoreReasoning: string | null;
  scoreComponents: ScoreComponent[];
  /**
   * The out_of_scope condition that forced the score to 0, when one matched.
   * Without this row the table cannot reconcile: the dimensions add to their
   * own mean and the score is 0 regardless of them.
   */
  scoreVeto: string | null;
  /** The dimensions' weighted mean, before any veto. */
  dimensionTotal: number | null;
}

/**
 * The score card: a plain verdict, the agent's own words, and the arithmetic
 * that produced the number, instead of the raw score_* rows + JSON blob it
 * writes. Reads across every family's fact list — score facts aren't reliably
 * confined to the "scoring" family in older data.
 *
 * The weights matter here, not just the sub-scores. A dimension that could not
 * be measured is dropped from the average and the rest are renormalized, so its
 * stored 0 is a placeholder. Reading the score_* rows straight, as this used
 * to, rendered that placeholder as "low" — the entity page said Wedotv's
 * network proximity was low when the truth was that it had no scored
 * connections to average.
 */
export function buildScoreCard(
  currentFacts: Record<string, FactLike[]>,
  weights?: ScoreWeights,
): ScoreCard {
  const allFacts = Object.values(currentFacts).flat();

  const factIdOf = new Map<string, string>();
  for (const f of allFacts) {
    if (f.predicate.startsWith('score_') && f.predicate !== 'score_total') {
      factIdOf.set(f.predicate.replace(/^score_/, ''), f.id);
    }
  }

  const parsed = breakdownFromFacts(allFacts);
  const explained = parsed ? explainScore(parsed.breakdown, weights) : null;
  const scoreComponents: ScoreComponent[] = explained
    ? explained.contributions.map((c) => {
      const meta = SCORE_DIMENSIONS[c.key];
      return {
        key: c.key,
        id: factIdOf.get(c.key) ?? null,
        label: meta?.label ?? humanizePredicate(c.key),
        help: meta?.help ?? null,
        value: c.value,
        measured: c.measured,
        unmeasuredReason: c.measured ? null : (meta?.unmeasured ?? 'not measured'),
        effectiveWeight: c.effective_weight,
        contribution: c.contribution,
      };
    })
    : [];

  const scoreReasoning = (() => {
    const f = allFacts.find((x) => x.predicate === 'icp_fit_breakdown');
    if (!f?.object_text) return null;
    try {
      const j = JSON.parse(f.object_text) as { reasoning?: unknown };
      return typeof j.reasoning === 'string' && j.reasoning.trim() ? j.reasoning.trim() : null;
    } catch { return null; }
  })();

  const scoreStr = (() => {
    for (const arr of Object.values(currentFacts)) {
      const f = arr.find((x) => x.predicate === 'icp_fit') ?? arr.find((x) => x.predicate === 'score_total');
      if (f?.object_text) return f.object_text;
    }
    return null;
  })();
  const score = scoreStr != null && Number.isFinite(parseFloat(scoreStr)) ? parseFloat(scoreStr) : null;

  return {
    score,
    scoreReasoning,
    scoreComponents,
    scoreVeto: explained?.out_of_scope ?? null,
    dimensionTotal: explained?.dimension_total ?? null,
  };
}
