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
};

/**
 * Merge workspace routing policy onto defaults. Each field falls back to the
 * default when unset, so a policy with only one tuned field still works.
 */
export function buildThresholds(policy?: {
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
}): ActionThresholds {
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
}

export function selectAction(args: SelectArgs): ActionDecision {
  const b = args.breakdown;
  const now = Date.now();
  const THRESH = args.thresholds ?? DEFAULT_THRESHOLDS;

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
  // contact were perfect. enrich_contacts exists to unblock drafting, so if the
  // draft bar is already failing on signal_strength, the contact is premature and
  // the credit is better spent on an account that would actually send. Not a
  // deadlock: signal_strength rises through research, which is now reachable.
  const couldDraftWithAContact = b.signal_strength >= THRESH.DRAFT_SIGNAL_STRENGTH;
  if (
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

  // 1. Draft if fit, trigger, and evidence all clear the bar. The "is there a
  //    real on-pitch reason to reach out" judgment lives in signal_strength (an
  //    LLM rubric scored against the workspace value prop), so the draft bar
  //    here IS the trigger gate — no separate keyword/theme check. Drafting now
  //    requires a real scored contact that clears the bar — never draft to a
  //    missing recipient. A zero-contact account would have routed to
  //    enrich_contacts at 0c; it only reaches here during the enrich cooldown
  //    window, in which case we watch instead of drafting to nobody.
  const draftAge = args.recent_draft_at
    ? (now - Date.parse(args.recent_draft_at)) / 86400_000
    : Infinity;
  if (
    args.icp_total >= THRESH.DRAFT_ICP_TOTAL &&
    b.signal_strength >= THRESH.DRAFT_SIGNAL_STRENGTH &&
    b.evidence_depth >= THRESH.DRAFT_EVIDENCE_DEPTH &&
    draftAge >= THRESH.DRAFT_SUPPRESSION_DAYS &&
    args.best_contact_score !== undefined &&
    args.best_contact_score >= THRESH.DRAFT_MIN_CONTACT_SCORE
  ) {
    return {
      action: 'draft_outreach',
      policy: 'qualified_and_triggered',
      reason: `Drafting: icp_total ${args.icp_total.toFixed(2)}, signal_strength ${b.signal_strength.toFixed(2)}, evidence_depth ${b.evidence_depth.toFixed(2)} all clear the threshold.`,
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
    if (b.signal_strength < THRESH.DRAFT_SIGNAL_STRENGTH) {
      blockers.push(`signal_strength ${b.signal_strength.toFixed(2)} is below ${THRESH.DRAFT_SIGNAL_STRENGTH}`);
    }
    if (b.evidence_depth < THRESH.DRAFT_EVIDENCE_DEPTH) {
      blockers.push(`evidence_depth ${b.evidence_depth.toFixed(2)} is below ${THRESH.DRAFT_EVIDENCE_DEPTH}`);
    }
    if (args.best_contact_score === undefined) {
      blockers.push('no scored contact to send to');
    } else if (args.best_contact_score < THRESH.DRAFT_MIN_CONTACT_SCORE) {
      blockers.push(`best contact score ${args.best_contact_score.toFixed(2)} is below ${THRESH.DRAFT_MIN_CONTACT_SCORE}`);
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
  // future, action_selector short-circuits to continue/suppressed.
  const dropped = await supabase
    .from('facts')
    .select('object_text')
    .eq('workspace_id', workspace_id)
    .eq('subject_entity', entity_id)
    .eq('predicate', 'dropped_until')
    .is('supersedes', null)
    .order('observed_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // outreach_cooldown_until fact — asserted after a send, blocks re-drafting.
  const cooldown = await supabase
    .from('facts')
    .select('object_text')
    .eq('workspace_id', workspace_id)
    .eq('subject_entity', entity_id)
    .eq('predicate', 'outreach_cooldown_until')
    .is('supersedes', null)
    .order('observed_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // contacts_requested marker — written to the event log when enrich_contacts
  // fired, so the selector doesn't re-request before the pull lands (cooldown).
  const recentContactsRequestAt = await latestMarkerAt(supabase, workspace_id, entity_id, [ACTIVITY_MARKERS.CONTACTS_REQUESTED]);

  return {
    recent_draft_at: (draft.data?.created_at as string) ?? null,
    recent_research_at: recentResearchAt,
    recent_contacts_request_at: recentContactsRequestAt,
    dropped_until: (dropped.data?.object_text as string) ?? null,
    cooldown_until: (cooldown.data?.object_text as string) ?? null,
  };
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
