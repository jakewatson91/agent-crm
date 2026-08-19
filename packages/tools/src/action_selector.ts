/**
 * Action selector — given the new multi-dim score plus the entity's history,
 * pick exactly one action. This replaces the bespoke "is icp_fit < 0.5"
 * gating that lived inside the drafter Inngest function and lets us route
 * to actions besides "draft or skip."
 *
 * Pure function: no side effects, no LLM call, no DB write. Inputs are the
 * already-loaded entity state; output is a categorical action plus a short
 * reason string for the decision post.
 *
 * Threshold rationale (calibrated against the user's "don't email someone
 * just for being on the YC page" constraint):
 *   - draft_outreach requires icp_total ≥ 0.65 AND signal_strength ≥ 0.7
 *     AND evidence_depth ≥ 0.5. All three. A directory mention scores
 *     signal_strength ≈ 0.3 and never gets through.
 *   - watch_only when fit is real but trigger is weak — keep enriching,
 *     don't bother the human.
 *   - deep_research when fit MIGHT be there but we lack the facts to know.
 *   - drop when clearly off-ICP, suppresses re-evaluation for 90 days.
 *   - continue is the default no-op.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ScoreBreakdown } from './scoring.ts';
import { latestMarkerAt, ACTIVITY_MARKERS } from './activity_markers.ts';
export type Action =
  | 'draft_outreach'
  | 'enrich_contacts'
  | 'watch_only'
  | 'deep_research'
  | 'drop'
  | 'continue';

export interface ActionDecision {
  action: Action;
  reason: string;            // 1-line explanation for the decision post
  policy: string;            // short id for analytics / inbox filtering
}

// ---- threshold defaults (overridable via workspace.policy.routing) ----
export interface ActionThresholds {
  DRAFT_ICP_TOTAL: number;
  DRAFT_SIGNAL_STRENGTH: number;
  DRAFT_EVIDENCE_DEPTH: number;
  DRAFT_SUPPRESSION_DAYS: number;
  RESEARCH_ICP_TOTAL: number;
  RESEARCH_COOLDOWN_DAYS: number;
  DROP_ICP_TOTAL: number;
  DROP_EVIDENCE_DEPTH: number;
  DROP_SUPPRESSION_DAYS: number;
  WATCH_ICP_TOTAL: number;
  // contact-aware routing (two-tier scoring)
  ENRICH_CONTACTS_ACCOUNT_ICP: number;
  DRAFT_MIN_CONTACT_SCORE: number;
  ENRICH_CONTACTS_COOLDOWN_DAYS: number;
  /**
   * Must we know a named person before drafting?
   *
   * This is not a preference, it follows from the channel. On email you cannot
   * send without an address, so it is mandatory. On LinkedIn you find the person
   * inside LinkedIn, whose search is better than any contact provider and free,
   * so buying contact data for a LinkedIn workspace pays for something the
   * founder does by hand thirty seconds later.
   *
   * It matters more than it sounds: 35 of the 67 accounts that cleared every bar
   * on Sudden had nobody attached. They queued for a contact pull every night,
   * the provider came back empty, and they sat there. One live pass: 400
   * scanned, 12 pulls attempted, 0 contacts created, 0 drafts.
   *
   * Defaults from outreach_channel; `policy.routing.require_contact` overrides
   * for anyone whose setup differs.
   */
  REQUIRE_CONTACT: boolean;
}

export const DEFAULT_THRESHOLDS: ActionThresholds = {
  DRAFT_ICP_TOTAL: 0.65,
  DRAFT_SIGNAL_STRENGTH: 0.7,
  DRAFT_EVIDENCE_DEPTH: 0.5,
  DRAFT_SUPPRESSION_DAYS: 14,

  RESEARCH_ICP_TOTAL: 0.5,
  RESEARCH_COOLDOWN_DAYS: 7,

  DROP_ICP_TOTAL: 0.35,
  DROP_EVIDENCE_DEPTH: 0.5,
  DROP_SUPPRESSION_DAYS: 90,

  WATCH_ICP_TOTAL: 0.5,

  ENRICH_CONTACTS_ACCOUNT_ICP: 0.6,
  DRAFT_MIN_CONTACT_SCORE: 0.5,
  ENRICH_CONTACTS_COOLDOWN_DAYS: 3,
  // Email is the default channel, and email cannot send to nobody.
  REQUIRE_CONTACT: true,
};

/**
 * Merge workspace routing policy onto defaults. Each field falls back to the
 * default when unset, so a policy with only one tuned field still works.
 */
export function buildThresholds(policy: {
  require_contact?: boolean;
  draft_icp_total?: number;
  draft_signal_strength?: number;
  draft_evidence_depth?: number;
  draft_suppression_days?: number;
  research_icp_total?: number;
  research_cooldown_days?: number;
  drop_icp_total?: number;
  drop_evidence_depth_min?: number;
  drop_suppression_days?: number;
  watch_icp_total?: number;
  enrich_contacts_account_icp?: number;
  draft_min_contact_score?: number;
  enrich_contacts_cooldown_days?: number;
} | undefined,
  /**
   * The channel this workspace sends on (policy.drafter.outreach_channel).
   *
   * Not a routing threshold, but it DERIVES one — whether a named recipient is
   * required before drafting — so it belongs here rather than being decided
   * separately by each caller.
   *
   * Deliberately a REQUIRED positional argument, even though its value may be
   * undefined. Folding it into the options object above would have made it one
   * more optional key on an all-optional shape, which is the arrangement that
   * has silently dropped a field at the buildSystemPrompt call site twice: it
   * type-checks clean and shows up weeks later as behaviour quietly missing.
   * Required means the compiler names every call site that has not thought
   * about it.
   */
  outreach_channel: 'email' | 'linkedin' | undefined,
): ActionThresholds {
  return {
    DRAFT_ICP_TOTAL: policy?.draft_icp_total ?? DEFAULT_THRESHOLDS.DRAFT_ICP_TOTAL,
    DRAFT_SIGNAL_STRENGTH: policy?.draft_signal_strength ?? DEFAULT_THRESHOLDS.DRAFT_SIGNAL_STRENGTH,
    DRAFT_EVIDENCE_DEPTH: policy?.draft_evidence_depth ?? DEFAULT_THRESHOLDS.DRAFT_EVIDENCE_DEPTH,
    DRAFT_SUPPRESSION_DAYS: policy?.draft_suppression_days ?? DEFAULT_THRESHOLDS.DRAFT_SUPPRESSION_DAYS,
    RESEARCH_ICP_TOTAL: policy?.research_icp_total ?? DEFAULT_THRESHOLDS.RESEARCH_ICP_TOTAL,
    RESEARCH_COOLDOWN_DAYS: policy?.research_cooldown_days ?? DEFAULT_THRESHOLDS.RESEARCH_COOLDOWN_DAYS,
    DROP_ICP_TOTAL: policy?.drop_icp_total ?? DEFAULT_THRESHOLDS.DROP_ICP_TOTAL,
    DROP_EVIDENCE_DEPTH: policy?.drop_evidence_depth_min ?? DEFAULT_THRESHOLDS.DROP_EVIDENCE_DEPTH,
    DROP_SUPPRESSION_DAYS: policy?.drop_suppression_days ?? DEFAULT_THRESHOLDS.DROP_SUPPRESSION_DAYS,
    WATCH_ICP_TOTAL: policy?.watch_icp_total ?? DEFAULT_THRESHOLDS.WATCH_ICP_TOTAL,
    ENRICH_CONTACTS_ACCOUNT_ICP: policy?.enrich_contacts_account_icp ?? DEFAULT_THRESHOLDS.ENRICH_CONTACTS_ACCOUNT_ICP,
    DRAFT_MIN_CONTACT_SCORE: policy?.draft_min_contact_score ?? DEFAULT_THRESHOLDS.DRAFT_MIN_CONTACT_SCORE,
    ENRICH_CONTACTS_COOLDOWN_DAYS: policy?.enrich_contacts_cooldown_days ?? DEFAULT_THRESHOLDS.ENRICH_CONTACTS_COOLDOWN_DAYS,
    // Explicit setting wins; otherwise the channel decides. LinkedIn sends are
    // copy-paste into LinkedIn, where the person is already in front of you.
    REQUIRE_CONTACT: policy?.require_contact ?? (outreach_channel === 'linkedin' ? false : DEFAULT_THRESHOLDS.REQUIRE_CONTACT),
  };
}

interface SelectArgs {
  workspace_id: string;
  entity_id: string;
  breakdown: ScoreBreakdown;
  icp_total: number;
  /**
   * Best contact_score over the account's contacts (max). undefined means the
   * account has no linked, scored contact — treated as "no reachable
   * decision-maker," which routes a strong-fit account to enrich_contacts and
   * blocks drafting (we never draft to a missing recipient). A defined value
   * below DRAFT_MIN_CONTACT_SCORE also routes to enrich_contacts.
   */
  best_contact_score?: number;
  // Recent activity context (already loaded in agent_logic before this call).
  recent_draft_at: string | null;     // most recent touch_draft created_at, or null
  recent_research_at: string | null;  // most recent deep_research trigger, or null
  recent_contacts_request_at?: string | null; // most recent contacts_requested fact, or null
  dropped_until: string | null;       // dropped_until fact value, or null
  cooldown_until: string | null;      // outreach_cooldown_until fact value, or null
  /** Per-workspace thresholds. When omitted, DEFAULT_THRESHOLDS apply. */
  thresholds?: ActionThresholds;
  /**
   * Whether this account has a dated event fresh enough to be the reason we
   * write — see anchor.ts. This replaces `signal_strength` as the condition that
   * decides WHETHER to write; the score stays a dimension of icp_total and keeps
   * deciding who goes first.
   *
   * undefined means the caller did not run the anchor test, and the old
   * signal_strength condition applies instead. That is what keeps every caller
   * that has not been updated behaving exactly as it did, rather than every
   * account in the book suddenly qualifying: measured on Sudden, dropping
   * signal_strength and leaving the other two bars takes the accounts that clear
   * them from 67 to 1,782, so the anchor is not an addition to the old test, it
   * is its replacement and has to arrive at the same time.
   */
  has_anchor?: boolean;
}

export function selectAction(args: SelectArgs): ActionDecision {
  const b = args.breakdown;
  const now = Date.now();
  const THRESH = args.thresholds ?? DEFAULT_THRESHOLDS;

  // Is there a reason to write to this company at all?
  //
  // When the caller ran the anchor test, the answer is a dated fact we can point
  // at, and `signal_strength` has nothing further to say about it. When it did
  // not, we fall back to the score. See has_anchor above for why the swap has to
  // be all-or-nothing rather than an extra condition.
  const reasonToWrite = args.has_anchor === undefined
    ? b.signal_strength >= THRESH.DRAFT_SIGNAL_STRENGTH
    : args.has_anchor;
  const noReasonText = args.has_anchor === undefined
    ? `signal_strength ${b.signal_strength.toFixed(2)} is below ${THRESH.DRAFT_SIGNAL_STRENGTH}`
    : 'nothing dated has happened here inside the freshness window';

  // 0. Hard suppression: agent previously dropped this entity, and the
  //    suppression window is still in effect.
  if (args.dropped_until) {
    const until = Date.parse(args.dropped_until);
    if (Number.isFinite(until) && until > now) {
      const daysLeft = Math.ceil((until - now) / 86400_000);
      return {
        action: 'continue',
        policy: 'dropped_suppressed',
        reason: `Suppressed: this entity was dropped ${daysLeft}d ago. Re-evaluating after ${new Date(until).toISOString().slice(0, 10)}.`,
      };
    }
  }

  // 0b. Post-send cooldown: a draft was approved and sent, block re-drafting
  //     until cooldown elapses.
  if (args.cooldown_until) {
    const until = Date.parse(args.cooldown_until);
    if (Number.isFinite(until) && until > now) {
      const daysLeft = Math.ceil((until - now) / 86400_000);
      return {
        action: 'continue',
        policy: 'outreach_cooldown_active',
        reason: `Cooldown: outreach sent recently. Re-evaluating after ${new Date(until).toISOString().slice(0, 10)} (${daysLeft}d left).`,
      };
    }
  }

  // 0c. Two-tier gate: a strong-fit account with no reachable decision-maker
  //     routes to enrich_contacts — go find a real contact before drafting.
  //     Two cases route here: (a) no contact linked at all (best_contact_score
  //     undefined), and (b) only a weak contact below the draft bar. Both mean
  //     "find a real person first." Placed before draft so a high-fit account
  //     never drafts to a missing or weak contact. The cooldown stops us
  //     re-requesting before an in-flight pull lands.
  const contactsReqAge = args.recent_contacts_request_at
    ? (now - Date.parse(args.recent_contacts_request_at)) / 86400_000
    : Infinity;
  const noReachableContact =
    args.best_contact_score === undefined ||
    args.best_contact_score < THRESH.DRAFT_MIN_CONTACT_SCORE;
  // Never buy a contact for an account nobody has looked at yet. This check sits
  // ahead of draft on purpose, and that also put it ahead of research at step 3,
  // so an unresearched account with a passable score was routed straight to a
  // paid contact lookup and never reached research at all. On Sudden that was
  // 1,621 accounts competing for the contact-provider credits, none of them
  // researched. recent_research_at is an all-history event marker, so null means
  // "never", not "not lately" (it would read stale if event retention is ever
  // switched on for the research-triggered marker).
  const everResearched = args.recent_research_at !== null;
  // And don't buy a contact for an account we could not draft to even if the
  // contact were perfect. enrich_contacts exists to unblock drafting, so if there
  // is no reason to write yet, the contact is premature and the credit is better
  // spent on an account that would actually send. Not a deadlock: research is what
  // turns up the dated event, and research is reachable below.
  //
  // This is also the fix for buying contacts in the wrong order. 59 of the 79
  // accounts with a fresh dated event had nobody to write to, while credits went
  // to accounts we had no reason to write to at all.
  const couldDraftWithAContact = reasonToWrite;
  if (
    THRESH.REQUIRE_CONTACT &&
    everResearched &&
    couldDraftWithAContact &&
    noReachableContact &&
    args.icp_total >= THRESH.ENRICH_CONTACTS_ACCOUNT_ICP &&
    contactsReqAge >= THRESH.ENRICH_CONTACTS_COOLDOWN_DAYS
  ) {
    const contactDesc = args.best_contact_score === undefined
      ? 'no contact is linked yet'
      : `best contact ${args.best_contact_score.toFixed(2)} is below ${THRESH.DRAFT_MIN_CONTACT_SCORE}`;
    return {
      action: 'enrich_contacts',
      policy: args.best_contact_score === undefined ? 'good_account_no_contact' : 'good_account_weak_contact',
      reason: `Enrich contacts: account fit ${args.icp_total.toFixed(2)} is strong but ${contactDesc}. Find a real decision-maker before drafting.`,
    };
  }

  // 1. Draft when there is a reason to write, the account fits, and we hold
  //    enough about them to write something true. The reason is the anchor: one
  //    dated event, inside the window, that this workspace is allowed to write
  //    about. It is deterministic, it shows on the approval card with the page it
  //    came from, and unlike a score it cannot disagree with the message.
  //    Drafting also requires a recipient unless the channel says otherwise — see
  //    require_contact.
  const draftAge = args.recent_draft_at
    ? (now - Date.parse(args.recent_draft_at)) / 86400_000
    : Infinity;
  if (
    args.icp_total >= THRESH.DRAFT_ICP_TOTAL &&
    reasonToWrite &&
    b.evidence_depth >= THRESH.DRAFT_EVIDENCE_DEPTH &&
    draftAge >= THRESH.DRAFT_SUPPRESSION_DAYS &&
    (!THRESH.REQUIRE_CONTACT ||
      (args.best_contact_score !== undefined && args.best_contact_score >= THRESH.DRAFT_MIN_CONTACT_SCORE))
  ) {
    return {
      action: 'draft_outreach',
      policy: 'qualified_and_triggered',
      reason: args.has_anchor === undefined
        ? `Drafting: icp_total ${args.icp_total.toFixed(2)}, signal_strength ${b.signal_strength.toFixed(2)}, evidence_depth ${b.evidence_depth.toFixed(2)} all clear the threshold.`
        : `Drafting: something dated happened here recently, icp_total ${args.icp_total.toFixed(2)} and evidence_depth ${b.evidence_depth.toFixed(2)} clear the bar.`,
    };
  }

  // 2. Drop if clearly off-ICP with enough evidence to be confident.
  if (args.icp_total < THRESH.DROP_ICP_TOTAL && b.evidence_depth >= THRESH.DROP_EVIDENCE_DEPTH) {
    return {
      action: 'drop',
      policy: 'off_icp_confident',
      reason: `Dropping: icp_total ${args.icp_total.toFixed(2)} below ${THRESH.DROP_ICP_TOTAL}, and we have ${(b.evidence_depth * 6).toFixed(0)}+ facts to be sure. Suppressing for ${THRESH.DROP_SUPPRESSION_DAYS}d.`,
    };
  }

  // 3. Deep research if there's a hint of fit and we're off cooldown.
  //
  //    This used to also require evidence_depth < RESEARCH_EVIDENCE_DEPTH (0.4),
  //    i.e. "only research accounts we know almost nothing about". That measured
  //    the wrong thing and switched research off for whole books. evidence_depth
  //    is substantive_facts/6, and it counts facts that arrived WITH the record
  //    as readily as facts we went and found. A CSV import carrying 5 columns
  //    (country, product, description, ...) puts every imported account at 0.83
  //    on day one, permanently above the 0.4 ceiling. Measured on Sudden: 1,884
  //    of 2,013 accounts (94%) were locked out of research from the moment they
  //    were imported, so signal_strength stayed at 0.40 ("passive presence") and
  //    nothing ever cleared the draft bar.
  //
  //    Knowing what a company IS was never the question research answers. It
  //    answers "is there a reason to reach out right now", which is time-bound
  //    and goes stale. So the cooldown is the correct and only limiter, and
  //    researchAge === Infinity (never researched) is exactly the case we most
  //    want to fire on. Spend stays bounded by research.searches_per_run.
  const researchAge = args.recent_research_at
    ? (now - Date.parse(args.recent_research_at)) / 86400_000
    : Infinity;
  if (
    args.icp_total >= THRESH.RESEARCH_ICP_TOTAL &&
    researchAge >= THRESH.RESEARCH_COOLDOWN_DAYS
  ) {
    const age = Number.isFinite(researchAge) ? `last researched ${researchAge.toFixed(0)}d ago` : 'never researched';
    return {
      action: 'deep_research',
      policy: 'fit_but_thin',
      reason: `Researching: icp_total ${args.icp_total.toFixed(2)} suggests possible fit and this account was ${age}. Looking for a current reason to reach out.`,
    };
  }

  // 4. Watch-only: fit is real but something blocks drafting. Name the actual
  //    failed condition(s) — the audit trail is how a human debugs "why no
  //    draft?", and a reason that always blames signal_strength lies whenever
  //    the true blocker is a missing contact, thin evidence, or the
  //    suppression window.
  if (args.icp_total >= THRESH.WATCH_ICP_TOTAL) {
    const blockers: string[] = [];
    if (args.icp_total < THRESH.DRAFT_ICP_TOTAL) {
      blockers.push(`icp_total ${args.icp_total.toFixed(2)} is below the draft bar ${THRESH.DRAFT_ICP_TOTAL}`);
    }
    if (!reasonToWrite) blockers.push(noReasonText);
    if (b.evidence_depth < THRESH.DRAFT_EVIDENCE_DEPTH) {
      blockers.push(`evidence_depth ${b.evidence_depth.toFixed(2)} is below ${THRESH.DRAFT_EVIDENCE_DEPTH}`);
    }
    if (THRESH.REQUIRE_CONTACT) {
      if (args.best_contact_score === undefined) {
        blockers.push('no scored contact to send to');
      } else if (args.best_contact_score < THRESH.DRAFT_MIN_CONTACT_SCORE) {
        blockers.push(`best contact score ${args.best_contact_score.toFixed(2)} is below ${THRESH.DRAFT_MIN_CONTACT_SCORE}`);
      }
    }
    if (draftAge < THRESH.DRAFT_SUPPRESSION_DAYS) {
      blockers.push(`last draft was ${draftAge.toFixed(1)}d ago (suppression window ${THRESH.DRAFT_SUPPRESSION_DAYS}d)`);
    }
    return {
      action: 'watch_only',
      policy: 'fit_weak_trigger',
      reason: `Watching: ${blockers.join('; ') || 'draft conditions met but not routed'}. Keep enriching; no draft.`,
    };
  }

  // 5. Default: no-op.
  return {
    action: 'continue',
    policy: 'no_threshold_met',
    reason: `No action: icp_total ${args.icp_total.toFixed(2)} doesn't meet any threshold (draft ${THRESH.DRAFT_ICP_TOTAL}, watch ${THRESH.WATCH_ICP_TOTAL}, drop with confidence at ${THRESH.DROP_ICP_TOTAL}).`,
  };
}

/**
 * Helper to load the recent-activity context selectAction needs. Kept here
 * so callers don't have to re-derive how each lookup works.
 */
export async function loadActionContext(
  supabase: SupabaseClient,
  workspace_id: string,
  entity_id: string,
  channel_id: string,
): Promise<{
  recent_draft_at: string | null;
  recent_research_at: string | null;
  recent_contacts_request_at: string | null;
  dropped_until: string | null;
  cooldown_until: string | null;
}> {
  // Most recent touch_draft in this channel.
  const draft = await supabase
    .from('channel_posts')
    .select('created_at')
    .eq('channel_id', channel_id)
    .eq('kind', 'touch_draft')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // Most recent research trigger — an event-log marker written when we kick off
  // Exa for an entity (reactive path or dispatcher). Used to enforce the
  // research cooldown so we don't re-trigger every cron tick.
  const recentResearchAt = await latestMarkerAt(supabase, workspace_id, entity_id, [ACTIVITY_MARKERS.RESEARCH_TRIGGERED]);

  // dropped_until fact — value is an ISO date string. If present and in the
  // future, action_selector short-circuits to continue/suppressed. The CURRENT
  // value is the row no other row's supersedes points at — supersede_fact
  // writes the new row pointing back at the old one, so `.is('supersedes',
  // null)` would return the stale original and could leave an entity
  // suppressed (or clear it) on a date a later fact already overrode. No
  // writer sets supersedes for this predicate today (drop always calls plain
  // assert_fact), so this is latent, not live — same class of bug as the
  // sweep.ts score_distribution read, fixed defensively before something
  // starts superseding it.
  const droppedRows = await supabase
    .from('facts')
    .select('id, object_text, supersedes')
    .eq('workspace_id', workspace_id)
    .eq('subject_entity', entity_id)
    .eq('predicate', 'dropped_until');
  const dropped = currentFact(droppedRows.data as CurrentFactRow[] | null);

  // outreach_cooldown_until fact — asserted after a send, blocks re-drafting.
  // Same not-pointed-to pattern, same latent risk.
  const cooldownRows = await supabase
    .from('facts')
    .select('id, object_text, supersedes')
    .eq('workspace_id', workspace_id)
    .eq('subject_entity', entity_id)
    .eq('predicate', 'outreach_cooldown_until');
  const cooldown = currentFact(cooldownRows.data as CurrentFactRow[] | null);

  // contacts_requested marker — written to the event log when enrich_contacts
  // fired, so the selector doesn't re-request before the pull lands (cooldown).
  const recentContactsRequestAt = await latestMarkerAt(supabase, workspace_id, entity_id, [ACTIVITY_MARKERS.CONTACTS_REQUESTED]);

  return {
    recent_draft_at: (draft.data?.created_at as string) ?? null,
    recent_research_at: recentResearchAt,
    recent_contacts_request_at: recentContactsRequestAt,
    dropped_until: dropped?.object_text ?? null,
    cooldown_until: cooldown?.object_text ?? null,
  };
}

type CurrentFactRow = { id: string; object_text: string | null; supersedes: string | null };

/** The row no other row's supersedes points at. Same pattern as loadBestContactScore below. */
function currentFact(rows: CurrentFactRow[] | null): CurrentFactRow | undefined {
  if (!rows?.length) return undefined;
  const pointedTo = new Set(rows.map((r) => r.supersedes).filter((x): x is string => !!x));
  return rows.find((r) => !pointedTo.has(r.id));
}

/**
 * Best contact_score over an account's contacts (max), for the two-tier gate.
 * Returns undefined when the account has no linked, scored contacts — selectAction
 * treats undefined as account-only, so callers can adopt this without changing
 * behavior until contacts are actually scored.
 */
export async function loadBestContactScore(
  supabase: SupabaseClient,
  workspace_id: string,
  account_entity_id: string,
): Promise<number | undefined> {
  const linked = await supabase
    .from('facts')
    .select('subject_entity')
    .eq('workspace_id', workspace_id)
    .eq('predicate', 'works_at')
    .eq('object_entity', account_entity_id)
    .is('supersedes', null);
  const contactIds = (linked.data ?? []).map((r) => r.subject_entity as string);
  if (!contactIds.length) return undefined;

  // The CURRENT fact in this codebase is the one no other row supersedes (the
  // newest row points at its predecessor). `supersedes is null` returns the
  // stale ORIGINAL, so fetch all contact_score rows and pick the not-pointed-to
  // one per contact.
  const scores = await supabase
    .from('facts')
    .select('id, object_text, supersedes')
    .eq('workspace_id', workspace_id)
    .eq('predicate', 'contact_score')
    .in('subject_entity', contactIds);
  const rows = (scores.data ?? []) as Array<{ id: string; object_text: string | null; supersedes: string | null }>;
  const pointedTo = new Set(rows.map((r) => r.supersedes).filter((x): x is string => !!x));
  const vals = rows
    .filter((r) => !pointedTo.has(r.id))
    .map((r) => parseFloat(r.object_text as string))
    .filter((n) => Number.isFinite(n));
  return vals.length ? Math.max(...vals) : undefined;
}
