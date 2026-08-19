/**
 * The anchor: the one dated thing that happened which a message is about.
 *
 * The system used to decide whether to write to a company by reading a score.
 * `signal_strength` asks "how actionable is the most recent signal FOR WHAT WE
 * SELL", which is a fit question wearing a timing costume — nothing in it asks
 * whether anything happened. Wedotv scored 0.70 on seven launches the drafter
 * then correctly refused to use, and having cleared the bar with nothing left to
 * open on, it opened on the company description. Meanwhile a Stingray agreement
 * with Titan OS for nine channels across Europe and a BT Sports multi-year
 * boxing deal both scored 0.4, "passive presence", and were never written to.
 *
 * So the question moves from the score to the facts. An anchor is one fact that
 * is all of:
 *
 *   1. something that HAPPENED — facts.happened_at is set. Not something the
 *      company is.
 *   2. inside the freshness window.
 *   3. not a subject this workspace said never to write about.
 *   4. not already used as the anchor of an earlier message to this account.
 *
 * Rules 1, 2 and 4 are pure code and live here. Rule 3 is one yes/no question
 * per candidate, asked by the caller against the top of the ranked list, because
 * a single-item question can afford to be strict: a false no costs the next
 * candidate rather than the whole account. That is what the old approach — hand
 * a model forty facts and ask which are off limits — could not afford, which is
 * why it needed a quote check bolted on, and why the quote check then made it
 * under-flag ("World Cup" does not contain the word "live").
 *
 * No anchor, no message. The anchor is both the reason we acted and the first
 * line of the message, so those two can never come apart again.
 *
 * IMPORTANT: this is a ranking plus a yes/no test, never a threshold. The whole
 * point of moving off the score is that a collapsed score stops being fatal — a
 * tie at 0.84 across a thousand accounts is harmless when the score only orders
 * a list, and ruinous when it is the cut-off.
 */

/** Freshness default. How fast news dies is a market judgment, so it is config. */
export const DEFAULT_ANCHOR_FRESH_DAYS = 30;

export interface AnchorCandidate {
  id: string;
  predicate: string;
  object_text: string | null;
  /** null = not an event, or an event nobody could date. Either way, not an anchor. */
  happened_at: string | null;
}

export interface AnchorPick {
  /** Ordered best-first. Empty means this account has no reason to be written to. */
  candidates: AnchorCandidate[];
  /** How many facts were considered, for the audit line. */
  considered: number;
  /** Why each rejected fact was rejected, tallied. Reads straight into a decision post. */
  rejected: Record<string, number>;
}

/**
 * Rank an account's facts as anchor candidates. Pure: no DB, no LLM.
 *
 * `usedFactIds` are facts already cited in a message to this account. Re-opening
 * on the same event is the single most obvious way a sequence reads as automated,
 * and the caller already loads this set for the over-use penalty in score_facts.
 */
export function pickAnchorCandidates(args: {
  facts: AnchorCandidate[];
  usedFactIds?: Iterable<string>;
  freshDays?: number;
  now?: number;
}): AnchorPick {
  const freshDays = args.freshDays && args.freshDays > 0 ? args.freshDays : DEFAULT_ANCHOR_FRESH_DAYS;
  const now = args.now ?? Date.now();
  const used = new Set(args.usedFactIds ?? []);
  const rejected: Record<string, number> = {};
  const reject = (why: string) => { rejected[why] = (rejected[why] ?? 0) + 1; };

  const candidates: Array<AnchorCandidate & { ms: number }> = [];
  for (const f of args.facts) {
    if (!f.happened_at) { reject('not_an_event'); continue; }
    const ms = Date.parse(f.happened_at);
    // A date we cannot read is not a date. Fail closed: it does not become fresh.
    if (!Number.isFinite(ms)) { reject('unreadable_date'); continue; }
    if ((now - ms) / 86400_000 > freshDays) { reject('older_than_window'); continue; }
    if (used.has(f.id)) { reject('already_used'); continue; }
    if (!f.object_text?.trim()) { reject('nothing_to_say'); continue; }
    candidates.push({ ...f, ms });
  }

  // Freshest first, then a stable tiebreak so the same account does not shuffle
  // its own anchor between two equally fresh events on consecutive runs.
  candidates.sort((a, b) => (b.ms - a.ms) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    candidates: candidates.map(({ ms: _ms, ...f }) => f),
    considered: args.facts.length,
    rejected,
  };
}

/**
 * The subjects a workspace never writes about, with the pre-split fallback.
 *
 * A workspace that configured `out_of_scope` before these were two separate
 * settings meant both jobs by it, so reading nothing here would silently switch
 * off the fact-level check it already relied on.
 */
export function cannotWriteAbout(drafter?: { cannot_write_about?: string[]; out_of_scope?: string[] }): string[] {
  const own = (drafter?.cannot_write_about ?? []).filter((s) => typeof s === 'string' && s.trim());
  if (own.length) return own;
  return (drafter?.out_of_scope ?? []).filter((s) => typeof s === 'string' && s.trim());
}
