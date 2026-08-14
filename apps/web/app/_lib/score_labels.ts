/**
 * Plain-language names + one-line explanations for the scoring dimensions, so
 * the score card can explain "how this number was reached" in words a
 * non-technical operator reads, instead of raw rubric field names.
 *
 * The set of dimensions IS the scoring framework — the same for every workspace
 * (the weights are tunable in workspace policy, the meanings are not), so it's
 * fine to live in code. No vertical or brand values here: these describe how
 * ANY account is scored. Keyed by the dimension name (the part after the
 * `score_` predicate prefix).
 */
export const SCORE_DIMENSIONS: Record<string, {
  label: string;
  help: string;
  /**
   * Why this dimension would come back unmeasured, in the reader's terms. A
   * dimension we could not measure is dropped from the average rather than
   * scored 0 (see combineSubScores), and the stored number is a placeholder.
   * Showing that placeholder is what made an unmeasured dimension read "low".
   */
  unmeasured?: string;
}> = {
  industry_match: { label: 'Industry match', help: 'How closely their market matches who you sell to.' },
  stage_match: {
    label: 'Stage & size',
    help: 'Whether their funding stage and team size fit your target.',
    unmeasured: 'no company size or funding on file',
  },
  signal_strength: { label: 'Signal strength', help: 'How strong the most recent reason to reach out is.' },
  evidence_depth: { label: 'Evidence depth', help: 'How much we actually know about them, versus guessing.' },
  recency: {
    label: 'Freshness',
    help: 'How recent the information we have on them is.',
    unmeasured: 'no dated source behind any fact',
  },
  graph_proximity: {
    label: 'Network proximity',
    help: 'How well their connections in your data fit.',
    unmeasured: 'no scored connections yet',
  },
};

/** Bucket a 0–1 sub-score into a word a person can read at a glance. */
export function scoreWord(v: number): string {
  return v >= 0.67 ? 'high' : v >= 0.34 ? 'medium' : 'low';
}
