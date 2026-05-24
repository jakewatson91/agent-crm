/**
 * WorkspacePolicy — every customer-varying value lives here, on workspaces.policy.
 * Substrate (events, facts, gates, scoring framework) stays in code; this is config.
 *
 * Defaults are vertical-neutral: a brand-new workspace can run safely without any
 * policy fields set. The backfill script preserves the existing dog-food values
 * for the original workspace.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface OutreachPolicy {
  override_to?: string | null;          // null/undefined = send to real recipient
  from_email?: string;                  // default DEFAULT_POLICY.outreach.from_email
  banned_phrases?: string[];            // stacks on top of code-level defaults
  resend_api_key?: string;              // workspace-scoped; secrets table later
}

export interface EnrichmentPolicy {
  contact_provider?: 'none' | 'hunter';
  /**
   * Hard cap on contact-provider lookups per calendar month for this workspace.
   * Counted via `contact_lookup_attempted` facts asserted this month. When
   * reached, drafter pre-flight skips the call and posts a system note. Unset
   * or 0 = no cap (legacy behavior).
   */
  hunter_monthly_cap?: number;
  /**
   * Vertical-specific extraction examples. Inserted into the enricher prompt
   * so the LLM extracts predicates relevant to THIS workspace's use case.
   * Empty array = use a vertical-neutral default in the prompt builder.
   */
  example_facts?: Array<{ predicate: string; object_text: string }>;
  /**
   * Predicates the enricher must never assert (e.g. "is_company", "exists").
   * Stacks on top of the code-level default ban list.
   */
  banned_predicates?: string[];
}

/**
 * Drafter policy — gates a draft on having a fact that maps to one of the
 * workspace's value-prop themes. Without this, drafts trigger off generic
 * fit (e.g. "they're on the YC page") which produces low-specificity emails.
 *
 * Each theme has a name (used in the drafter prompt as PRIMARY_ANGLE) and a
 * regex pattern (matched against predicate + object_text on the entity's
 * active facts, case-insensitive). Default `value_themes: []` = gate is off,
 * preserves backward compatibility.
 *
 * cooldown_days: after a draft is sent (gate approved), block re-drafting
 * for this many days via the `outreach_cooldown_until` fact.
 */
export interface ValueTheme {
  name: string;
  pattern: string; // regex source, compiled at use site
}
export interface DrafterPolicy {
  value_themes?: ValueTheme[];
  cooldown_days?: number;

  // ---- email formula (new in Phase 3) ----
  /** How the subject line looks. Default 'one_word'. */
  subject_style?: 'one_word' | 'short_phrase' | 'question';
  /** Target paragraph count for the body. Default 4. */
  paragraph_count?: number;
  /**
   * Workspace-specific pains the product addresses. Rendered as bullets in
   * the prompt's "PROBLEM STATEMENT" section. Drafter picks the one that
   * fits the prospect; doesn't list them all in the email.
   */
  pain_points?: string[];
  /**
   * Concrete behaviors / numbers the drafter can cite in the one-liner.
   * "We benchmarked HubSpot losing 96% of writes under concurrent edits"
   * is better than "we're agent-native."
   */
  value_props?: string[];
  /** Tone keywords baked into the prompt: ["casual", "direct", "concrete"]. */
  tone_keywords?: string[];
  /**
   * Example ask phrasings. Drafter picks one or rephrases.
   * ["Worth exploring?", "Open to a 15-min chat?", "Want to see it run?"]
   */
  ask_examples?: string[];
}

/**
 * LLM keys + model preferences scoped to the workspace.
 *
 * Stopgap until a real per-workspace secrets table exists — keys live on
 * the policy jsonb. Each one is optional; when unset, callers fall back
 * to the corresponding process.env variable so the demo workspace keeps
 * working without a migration.
 *
 * Model routing follows the chatComplete convention:
 *   - bare id (e.g. "gpt-4o-mini")        → OpenAI direct (uses openai_api_key)
 *   - slash-prefixed (e.g. "deepseek/...") → OpenRouter (uses openrouter_api_key)
 */
export interface LLMPolicy {
  openai_api_key?: string;
  openrouter_api_key?: string;
  /** Direct DeepSeek API key. Used by the chat intake route via the AI SDK. */
  deepseek_api_key?: string;
  /** Optional override of the workspace-wide cheap default. Unset = code default. */
  default_chat_model?: string;
  /** Optional override of the drafter model specifically (the customer-facing one). */
  drafter_model?: string;
}

/**
 * Action-selector thresholds. Decide when an entity routes to draft / watch /
 * research / drop. All optional; unset = use code defaults.
 *
 * Two main knobs a customer might want:
 *   - draft_icp_total: bar for "ready to email" (default 0.65). Lower = more
 *     drafts, more noise. Higher = pickier.
 *   - drop_icp_total: bar for "give up on this entity for 90 days" (default
 *     0.35). Lower = give up faster.
 */
export interface RoutingPolicy {
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
}

/**
 * Scoring weights for combineSubScores. Must sum to 1.0 in spirit; if a
 * customer sets weights that don't, the score gets clamped to [0,1] anyway.
 *
 * rrf_gate: if the multi-perspective RRF prefilter score is below this AND
 * evidence_depth is also low, skip the LLM call entirely and use the RRF
 * score as a rough proxy. Default 0.3.
 */
export interface ScoringPolicy {
  weights?: {
    industry_match?: number;
    stage_match?: number;
    signal_strength?: number;
    evidence_depth?: number;
    recency?: number;
    graph_proximity?: number;
  };
  rrf_gate?: number;
}

/**
 * Hiring-signal filter. Applied at the ATS connector: only postings whose
 * classified role passes this filter become signals. Vertical-neutral —
 * the families/seniorities are a fixed taxonomy in classify_role.ts, and
 * each workspace picks which ones count for its buyer.
 *
 * Unset / empty filter → include everything (preserves pre-filter behavior).
 */
export interface HiringFilterPolicy {
  include_families?: string[];      // RoleFamily values from classify_role.ts
  include_seniorities?: string[];   // RoleSeniority values from classify_role.ts
  exclude_families?: string[];
  /** Always pass postings classified as is_exec, even if seniority isn't in include list. */
  always_include_exec?: boolean;
}

export interface WorkspacePolicy {
  // pre-existing fields
  suppression_list?: string[];
  daily_send_cap?: number;
  notify_channels?: string[];

  // new structured sections
  outreach?: OutreachPolicy;
  enrichment?: EnrichmentPolicy;
  drafter?: DrafterPolicy;
  llm?: LLMPolicy;
  routing?: RoutingPolicy;
  scoring?: ScoringPolicy;
  hiring_filter?: HiringFilterPolicy;

  /**
   * Generic env-var bag for this workspace. Flat dict of NAME → value.
   * Readers (LLM call, Resend send, etc.) check this BEFORE the legacy named
   * fields (policy.llm.openai_api_key, policy.outreach.resend_api_key)
   * and BEFORE process.env. The settings UI surfaces this as a Render-style
   * KV editor — any var the loop might consult goes here. No predetermined
   * names; canonical names recognized by the loop today:
   *   OPENAI_API_KEY      — LLM calls + embeddings (chat_workspace.ts)
   *   OPENROUTER_API_KEY  — slash-prefixed models (chat_workspace.ts)
   *   DEFAULT_CHAT_MODEL  — workspace default model override
   *   DRAFTER_MODEL       — drafter-behavior model override
   *   RESEND_API_KEY      — outbound email (send_email.ts)
   * Setting other vars here is fine — they're stored, but no reader consults
   * them yet (e.g. HUNTER_API_KEY is read from process.env only, pending follow-up).
   */
  env?: Record<string, string>;
}

/**
 * Look up a workspace-scoped env var. Resolution order:
 *   1. policy.env[name]        — Render-style override per workspace
 *   2. legacyLookup(policy)    — back-compat with named policy.* fields
 *   3. process.env[name]       — single-tenant fallback
 */
export function resolveEnvVar(
  policy: WorkspacePolicy,
  name: string,
  legacyLookup?: (p: WorkspacePolicy) => string | undefined,
): string | undefined {
  const fromEnv = policy.env?.[name];
  if (fromEnv && fromEnv.length) return fromEnv;
  if (legacyLookup) {
    const legacy = legacyLookup(policy);
    if (legacy && legacy.length) return legacy;
  }
  return process.env[name];
}

export const DEFAULT_POLICY: Required<Pick<WorkspacePolicy, 'outreach' | 'enrichment' | 'drafter' | 'llm' | 'routing' | 'scoring'>> & WorkspacePolicy = {
  outreach: {
    override_to: null,
    from_email: 'onboarding@resend.dev',
    banned_phrases: [],
  },
  enrichment: {
    contact_provider: 'none',
  },
  drafter: {
    value_themes: [],
    cooldown_days: 14,
  },
  llm: {},
  routing: {},
  scoring: {},
};

/**
 * Read workspaces.policy and shallow-merge each section with DEFAULT_POLICY.
 * Returns DEFAULT_POLICY (no errors thrown) if the workspace is missing — callers
 * decide whether that's a fatal condition.
 */
export async function getPolicy(supabase: SupabaseClient, workspace_id: string): Promise<WorkspacePolicy> {
  const r = await supabase.from('workspaces').select('policy').eq('id', workspace_id).maybeSingle();
  const raw = (r.data?.policy ?? {}) as WorkspacePolicy;
  return {
    ...raw,
    outreach: { ...DEFAULT_POLICY.outreach, ...(raw.outreach ?? {}) },
    enrichment: { ...DEFAULT_POLICY.enrichment, ...(raw.enrichment ?? {}) },
    drafter: { ...DEFAULT_POLICY.drafter, ...(raw.drafter ?? {}) },
    llm: { ...DEFAULT_POLICY.llm, ...(raw.llm ?? {}) },
    routing: { ...DEFAULT_POLICY.routing, ...(raw.routing ?? {}) },
    scoring: { ...DEFAULT_POLICY.scoring, ...(raw.scoring ?? {}) },
    env: { ...(raw.env ?? {}) },
  };
}
