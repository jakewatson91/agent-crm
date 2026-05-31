/**
 * Fact-display grouping. The audit/read surfaces (entity facts route, channel
 * summary) show active facts under named headings. Which predicate shows under
 * which heading is CONFIG, not code: the group definitions live on
 * workspaces.policy.display.fact_groups so a customer in any vertical can
 * regroup their own predicates without a code change.
 *
 * A group matches a predicate by exact name (`predicates`) or by prefix
 * (`prefixes`, e.g. "score_" catches every per-dimension scoring fact). First
 * matching group in the array wins; anything unmatched falls under "other".
 * Default (no groups configured) = every predicate is "other".
 */
export interface FactGroup {
  name: string;
  predicates?: string[];
  prefixes?: string[];
}
export interface DisplayPolicy {
  fact_groups?: FactGroup[];
}

export function factFamilyOf(predicate: string, groups: FactGroup[] = []): string {
  for (const g of groups) {
    if (g.predicates?.includes(predicate)) return g.name;
    if (g.prefixes?.some((p) => predicate.startsWith(p))) return g.name;
  }
  return 'other';
}
