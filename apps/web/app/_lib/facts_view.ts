/**
 * Shared "what counts as a human-visible fact" + score-card derivation logic.
 * One definition so the full entity page and the drawer's compact entity view
 * always agree on what to show and hide — see labels.ts for the underlying
 * code-detection rules this builds on.
 */
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
  id: string;
  label: string;
  help: string | null;
  value: number;
}

export interface ScoreCard {
  score: number | null;
  scoreReasoning: string | null;
  scoreComponents: ScoreComponent[];
}

/**
 * The score card: a plain verdict + the agent's own words, instead of the raw
 * score_* rows + JSON blob it writes. Reads across every family's fact list —
 * score facts aren't reliably confined to the "scoring" family in older data.
 */
export function buildScoreCard(currentFacts: Record<string, FactLike[]>): ScoreCard {
  const allFacts = Object.values(currentFacts).flat();

  const scoreComponents = allFacts
    .filter((f) => f.predicate.startsWith('score_') && f.predicate !== 'score_total' && f.object_text != null)
    .map((f) => {
      const key = f.predicate.replace(/^score_/, '');
      const meta = SCORE_DIMENSIONS[key];
      return { key, id: f.id, label: meta?.label ?? humanizePredicate(key), help: meta?.help ?? null, value: parseFloat(f.object_text as string) };
    })
    .filter((c) => Number.isFinite(c.value));

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

  return { score, scoreReasoning, scoreComponents };
}
