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
  /** Optional override of the workspace-wide cheap default. Unset = code default. */
  default_chat_model?: string;
  /** Optional override of the drafter model specifically (the customer-facing one). */
  drafter_model?: string;
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
}

export const DEFAULT_POLICY: Required<Pick<WorkspacePolicy, 'outreach' | 'enrichment' | 'drafter' | 'llm'>> & WorkspacePolicy = {
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
  };
}
