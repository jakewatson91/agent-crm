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
import type { ScoreBreakdown } from './scoring.js';
import type { ValueTheme } from './policy.js';

export type Action =
  | 'draft_outreach'
  | 'watch_only'
  | 'deep_research'
  | 'drop'
  | 'continue';

export interface ActionDecision {
  action: Action;
  reason: string;            // 1-line explanation for the decision post
  policy: string;            // short id for analytics / inbox filtering
  matched_theme?: string | null;  // populated on draft_outreach when a value theme matched
  matched_evidence?: string | null; // the predicate=value pair that matched
}

interface ValueMatch {
  aligned: boolean;
  theme: string | null;
  predicate: string | null;
  evidence: string | null; // "predicate=object_text" for the matched fact
}

/**
 * Scan facts for at least one match against the workspace's value-prop themes.
 * Matching is case-insensitive substring against `predicate object_text`. Empty
 * themes array short-circuits to aligned=true (gate is off).
 */
export function hasValueAlignedFact(
  facts: Array<{ predicate: string; object_text: string | null }>,
  themes: ValueTheme[],
): ValueMatch {
  if (!themes.length) return { aligned: true, theme: null, predicate: null, evidence: null };
  for (const theme of themes) {
    let re: RegExp;
    try {
      re = new RegExp(theme.pattern, 'i');
    } catch {
      continue; // skip malformed pattern; policy is user input
    }
    for (const f of facts) {
      const haystack = `${f.predicate} ${f.object_text ?? ''}`;
      if (re.test(haystack)) {
        return {
          aligned: true,
          theme: theme.name,
          predicate: f.predicate,
          evidence: `${f.predicate}=${(f.object_text ?? '').slice(0, 80)}`,
        };
      }
    }
  }
  return { aligned: false, theme: null, predicate: null, evidence: null };
}

// ---- threshold defaults (overridable via workspace.policy.routing) ----
export interface ActionThresholds {
  DRAFT_ICP_TOTAL: number;
  DRAFT_SIGNAL_STRENGTH: number;
  DRAFT_EVIDENCE_DEPTH: number;
  DRAFT_SUPPRESSION_DAYS: number;
  RESEARCH_ICP_TOTAL: number;
  RESEARCH_EVIDENCE_DEPTH: number;
  RESEARCH_COOLDOWN_DAYS: number;
  DROP_ICP_TOTAL: number;
  DROP_EVIDENCE_DEPTH: number;
  DROP_SUPPRESSION_DAYS: number;
  WATCH_ICP_TOTAL: number;
}

export const DEFAULT_THRESHOLDS: ActionThresholds = {
  DRAFT_ICP_TOTAL: 0.65,
  DRAFT_SIGNAL_STRENGTH: 0.7,
  DRAFT_EVIDENCE_DEPTH: 0.5,
  DRAFT_SUPPRESSION_DAYS: 14,

  RESEARCH_ICP_TOTAL: 0.5,
  RESEARCH_EVIDENCE_DEPTH: 0.4,
  RESEARCH_COOLDOWN_DAYS: 7,

  DROP_ICP_TOTAL: 0.35,
  DROP_EVIDENCE_DEPTH: 0.5,
  DROP_SUPPRESSION_DAYS: 90,

  WATCH_ICP_TOTAL: 0.5,
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
  research_evidence_depth_max?: number;
  research_cooldown_days?: number;
  drop_icp_total?: number;
  drop_evidence_depth_min?: number;
  drop_suppression_days?: number;
  watch_icp_total?: number;
}): ActionThresholds {
  return {
    DRAFT_ICP_TOTAL: policy?.draft_icp_total ?? DEFAULT_THRESHOLDS.DRAFT_ICP_TOTAL,
    DRAFT_SIGNAL_STRENGTH: policy?.draft_signal_strength ?? DEFAULT_THRESHOLDS.DRAFT_SIGNAL_STRENGTH,
    DRAFT_EVIDENCE_DEPTH: policy?.draft_evidence_depth ?? DEFAULT_THRESHOLDS.DRAFT_EVIDENCE_DEPTH,
    DRAFT_SUPPRESSION_DAYS: policy?.draft_suppression_days ?? DEFAULT_THRESHOLDS.DRAFT_SUPPRESSION_DAYS,
    RESEARCH_ICP_TOTAL: policy?.research_icp_total ?? DEFAULT_THRESHOLDS.RESEARCH_ICP_TOTAL,
    RESEARCH_EVIDENCE_DEPTH: policy?.research_evidence_depth_max ?? DEFAULT_THRESHOLDS.RESEARCH_EVIDENCE_DEPTH,
    RESEARCH_COOLDOWN_DAYS: policy?.research_cooldown_days ?? DEFAULT_THRESHOLDS.RESEARCH_COOLDOWN_DAYS,
    DROP_ICP_TOTAL: policy?.drop_icp_total ?? DEFAULT_THRESHOLDS.DROP_ICP_TOTAL,
    DROP_EVIDENCE_DEPTH: policy?.drop_evidence_depth_min ?? DEFAULT_THRESHOLDS.DROP_EVIDENCE_DEPTH,
    DROP_SUPPRESSION_DAYS: policy?.drop_suppression_days ?? DEFAULT_THRESHOLDS.DROP_SUPPRESSION_DAYS,
    WATCH_ICP_TOTAL: policy?.watch_icp_total ?? DEFAULT_THRESHOLDS.WATCH_ICP_TOTAL,
  };
}

interface SelectArgs {
  workspace_id: string;
  entity_id: string;
  breakdown: ScoreBreakdown;
  icp_total: number;
  // Recent activity context (already loaded in agent_logic before this call).
  recent_draft_at: string | null;     // most recent touch_draft created_at, or null
  recent_research_at: string | null;  // most recent deep_research trigger, or null
  dropped_until: string | null;       // dropped_until fact value, or null
  cooldown_until: string | null;      // outreach_cooldown_until fact value, or null
  // Substantive facts for value-theme matching. Pass [] to disable the gate.
  facts: Array<{ predicate: string; object_text: string | null }>;
  value_themes: ValueTheme[];
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

  // 1. Draft if fit, trigger, and evidence all clear the bar AND the entity
  //    has a fact aligned with a workspace value theme. Without alignment we
  //    have nothing specific to say — defer to watch_only.
  const draftAge = args.recent_draft_at
    ? (now - Date.parse(args.recent_draft_at)) / 86400_000
    : Infinity;
  if (
    args.icp_total >= THRESH.DRAFT_ICP_TOTAL &&
    b.signal_strength >= THRESH.DRAFT_SIGNAL_STRENGTH &&
    b.evidence_depth >= THRESH.DRAFT_EVIDENCE_DEPTH &&
    draftAge >= THRESH.DRAFT_SUPPRESSION_DAYS
  ) {
    const match = hasValueAlignedFact(args.facts, args.value_themes);
    if (match.aligned) {
      const themeNote = match.theme ? ` Theme: ${match.theme} (${match.evidence}).` : '';
      return {
        action: 'draft_outreach',
        policy: 'qualified_and_triggered',
        reason: `Drafting: icp_total ${args.icp_total.toFixed(2)}, signal_strength ${b.signal_strength.toFixed(2)}, evidence_depth ${b.evidence_depth.toFixed(2)} all clear the threshold.${themeNote}`,
        matched_theme: match.theme,
        matched_evidence: match.evidence,
      };
    }
    return {
      action: 'watch_only',
      policy: 'no_value_aligned_signal',
      reason: `Thresholds met (icp ${args.icp_total.toFixed(2)}, signal ${b.signal_strength.toFixed(2)}, evidence ${b.evidence_depth.toFixed(2)}) but no fact matches a value theme. Need a hiring / headcount / token-cost / AI-integration signal before drafting.`,
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

  // 3. Deep research if there's a hint of fit but not enough evidence.
  const researchAge = args.recent_research_at
    ? (now - Date.parse(args.recent_research_at)) / 86400_000
    : Infinity;
  if (
    args.icp_total >= THRESH.RESEARCH_ICP_TOTAL &&
    b.evidence_depth < THRESH.RESEARCH_EVIDENCE_DEPTH &&
    researchAge >= THRESH.RESEARCH_COOLDOWN_DAYS
  ) {
    return {
      action: 'deep_research',
      policy: 'fit_but_thin',
      reason: `Researching: icp_total ${args.icp_total.toFixed(2)} suggests possible fit, but evidence_depth is only ${b.evidence_depth.toFixed(2)}. Pulling more context before deciding.`,
    };
  }

  // 4. Watch-only: fit is real but trigger is weak. Keep enriching, no draft.
  if (args.icp_total >= THRESH.WATCH_ICP_TOTAL) {
    return {
      action: 'watch_only',
      policy: 'fit_weak_trigger',
      reason: `Watching: icp_total ${args.icp_total.toFixed(2)} is decent but signal_strength ${b.signal_strength.toFixed(2)} is weak. Keep enriching; no draft.`,
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

  // Most recent deep_research event (we write a `research_triggered` fact
  // with observed_at when we kick off Exa for an entity).
  const research = await supabase
    .from('facts')
    .select('observed_at')
    .eq('workspace_id', workspace_id)
    .eq('subject_entity', entity_id)
    .eq('predicate', 'research_triggered')
    .is('supersedes', null)
    .order('observed_at', { ascending: false })
    .limit(1)
    .maybeSingle();

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

  return {
    recent_draft_at: (draft.data?.created_at as string) ?? null,
    recent_research_at: (research.data?.observed_at as string) ?? null,
    dropped_until: (dropped.data?.object_text as string) ?? null,
    cooldown_until: (cooldown.data?.object_text as string) ?? null,
  };
}
