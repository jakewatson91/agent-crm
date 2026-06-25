/**
 * Decision bands mirror the action_selector thresholds, so filtering by band
 * is auditing *what the agent decides to do*, not building a lead list. Shared
 * by the entities index, the feed audit filters, and the entity identity strip
 * so the cutoffs can't drift between surfaces.
 */

export type Band = 'all' | 'draft' | 'watch' | 'noaction' | 'drop' | 'unscored';
export type ScoredBand = Exclude<Band, 'all'>;

export function bandOf(icp: number | null): ScoredBand {
  if (icp === null) return 'unscored';
  if (icp >= 0.65) return 'draft';
  if (icp >= 0.5) return 'watch';
  if (icp >= 0.35) return 'noaction';
  return 'drop';
}

// Full labels incl. thresholds — for filter dropdowns.
export const BAND_LABEL: Record<Band, string> = {
  all: 'any score',
  draft: 'draft-ready (≥ 0.65)',
  watch: 'watching (0.5–0.65)',
  noaction: 'no action (0.35–0.5)',
  drop: 'dropped (< 0.35)',
  unscored: 'unscored',
};

// Short labels — for inline chips next to a score.
export const BAND_SHORT: Record<ScoredBand, string> = {
  draft: 'draft-ready',
  watch: 'watching',
  noaction: 'no action',
  drop: 'dropped',
  unscored: 'unscored',
};

// One-word verdict for the human score card headline. Says "how good a fit",
// not the internal action label.
export const BAND_HEADLINE: Record<ScoredBand, string> = {
  draft: 'Strong fit',
  watch: 'Possible fit',
  noaction: 'Weak fit',
  drop: 'Not a fit',
  unscored: 'Not scored yet',
};

// What the agent will actually DO at each band, in plain words — the
// audit-useful framing of the score, so a person reading the page understands
// the consequence, not just a number.
export const BAND_VERDICT: Record<ScoredBand, string> = {
  draft: 'Good enough that the agent will draft outreach.',
  watch: 'Promising — the agent is waiting for a stronger reason before reaching out.',
  noaction: 'Below the outreach bar — the agent takes no action for now.',
  drop: 'Not a fit — the agent has set this one aside.',
  unscored: "The agent hasn't scored this one yet.",
};

export function bandColor(icp: number | null): string {
  if (icp === null) return 'var(--text-3)';
  if (icp >= 0.7) return 'var(--accent-green)';
  if (icp >= 0.5) return 'var(--accent-amber)';
  return 'var(--accent-coral)';
}
