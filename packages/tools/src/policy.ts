/**
 * WorkspacePolicy — every customer-varying value lives here, on workspaces.policy.
 * Substrate (events, facts, gates, scoring framework) stays in code; this is config.
 *
 * Defaults are vertical-neutral: a brand-new workspace can run safely without any
 * policy fields set. The backfill script preserves the existing dog-food values
 * for the original workspace.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DisplayPolicy } from './fact_groups.ts';

export interface OutreachPolicy {
  override_to?: string | null;          // null/undefined = send to real recipient
  from_email?: string;                  // default DEFAULT_POLICY.outreach.from_email
  banned_phrases?: string[];            // stacks on top of code-level defaults
  resend_api_key?: string;              // workspace-scoped; secrets table later
}

export interface EnrichmentPolicy {
  // Primary contact provider. 'hunter' (keyed by HUNTER_API_KEY) is broad but
  // weak on young startups; 'explorium' (keyed per-workspace via EXPLORIUM_API_KEY)
  // covers small startups better.
  contact_provider?: 'none' | 'hunter' | 'explorium';
  /**
   * Optional second provider, tried only when the primary returns zero contacts
   * or errors. Lets a workspace run e.g. Explorium-first, Hunter-fallback. Unset
   * = no fallback (single-provider behavior).
   */
  contact_provider_fallback?: 'none' | 'hunter' | 'explorium';
  /**
   * Max contact pulls the daily loop runs per pass for this workspace. Caps how
   * fast a backlog of enrich_contacts requests drains so one run can't burn the
   * whole provider quota; highest-scoring accounts go first. Default 5. Set 0 to
   * disable loop-driven draining (e.g. rely on Inngest only).
   */
  max_contact_pulls_per_run?: number;
  /**
   * Coalesce window in minutes for repeat enrichment of the SAME entity on the
   * SAME signal type. A company with N open job posts emits N hiring_post signals;
   * without this, each fires a full LLM enrich. When the enricher is triggered for
   * a signal whose entity already had an earlier same-type signal within this
   * window, the run skips the LLM extraction — the burst's first signal already
   * captured the trend. Generic and vertical-neutral: only collapses same-entity +
   * same-type bursts, so different signal types and different entities always run.
   * Default 60. Set 0 to disable and enrich every signal.
   */
  coalesce_window_min?: number;
  /**
   * Per-entity enrichment cooldown in hours. When an enricher run successfully
   * asserted facts for an entity within this window, new signals for that same
   * entity are skipped — the entity is already up to date. Prevents high-volume
   * sources (e.g. ATS feeds) from re-enriching the same well-known account every
   * time a new job posting lands. Default 20h. Set 0 to disable.
   */
  entity_enrich_cooldown_hours?: number;
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
 * Drafter policy. The "is there a real on-pitch reason to reach out" decision
 * lives in the LLM signal_strength score (rated against value_props), not a
 * keyword gate — see action_selector. value_props/pain_points shape the email.
 *
 * cooldown_days: after a draft is sent (gate approved), block re-drafting
 * for this many days via the `outreach_cooldown_until` fact.
 */
export interface DrafterPolicy {
  cooldown_days?: number;

  /**
   * Which channel to draft for. Defaults to 'email' when unset.
   * 'linkedin' produces a short connection-request message (≤250 chars, no subject)
   * instead of a full cold email.
   */
  outreach_channel?: 'email' | 'linkedin';

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
  /**
   * Internal field/column names the drafter must never echo into an email
   * ("domain", "tech_stack", "score", ...). These are THIS workspace's own
   * field names — a different vertical has different ones — so they're config,
   * not code. Default empty = rely on the generic "don't name internal fields"
   * rule in the drafter prompt.
   */
  forbidden_field_terms?: string[];
  /**
   * Phase 0 market brief. A small, hand-written list of current, dated market
   * hooks injected into the drafter's system prompt as background context.
   * The shape is here; the contents live on workspaces.policy and default to off.
   * No automated sourcing yet: items are written by hand (later, a refresh job
   * can patch this same field). Behind `enabled`, so absent or off renders
   * nothing and the prompt stays byte-identical to today.
   */
  market_brief?: {
    enabled?: boolean;
    items?: Array<{ text: string; url?: string; date?: string }>;
  };
}

/**
 * LLM keys + model preferences scoped to the workspace.
 *
 * Stopgap until a real per-workspace secrets table exists — keys live on
 * the policy jsonb. Each one is optional; when unset, callers fall back
 * to the corresponding process.env variable so the demo workspace keeps
 * working without a migration.
 *
 * Model routing follows the chatComplete convention (model_registry.ts):
 *   - "deepseek/<model>" (or bare) → DeepSeek direct (uses deepseek_api_key)
 *   - "<vendor>/<model>"           → Vercel AI Gateway (AI_GATEWAY_API_KEY)
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

  // ---- contact-aware routing (two-tier scoring) ----
  /** Account fit bar above which a weak/missing contact routes to enrich_contacts. Default 0.6. */
  enrich_contacts_account_icp?: number;
  /** Min best-contact score required to draft (vs enrich a better contact). Default 0.5. */
  draft_min_contact_score?: number;
  /** Days to wait before re-requesting a contact pull for the same account. Default 3. */
  enrich_contacts_cooldown_days?: number;
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
 * Contact-scoring weights. Same six slots as ScoringPolicy, remapped in meaning
 * for a person (the scorer reuses the ScoreBreakdown struct):
 *   industry_match  -> persona match (role vs target buyer roles)
 *   stage_match     -> decision power (seniority / authority)
 *   signal_strength -> contact-level signal (job change, social post)
 *   graph_proximity -> parent account fit (one-way: contact <- account)
 * Account scoring is unaffected — contacts store `contact_score`, never `icp_fit`.
 */
export interface ContactScoringPolicy {
  weights?: {
    persona_match?: number;
    decision_power?: number;
    signal_strength?: number;
    evidence_depth?: number;
    recency?: number;
    account_fit?: number;
  };
}

/**
 * Persona targeting — who counts as a buyer for this workspace. Drives the
 * contact scorer's persona_match. VERTICAL-NEUTRAL: empty by default, so a
 * fresh workspace falls back to seniority as the proxy (a senior person is a
 * plausible decision-maker) and never assumes a vertical. Each customer fills
 * in their own buyer roles.
 *
 * target_roles: regex / substring patterns matched against the contact's role
 *   text (case-insensitive), e.g. ["founder", "head of (sales|growth)"].
 */
export interface PersonaPolicy {
  target_roles?: string[];
  decision_power_hint?: string;
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

/**
 * Outreach-lifecycle marker. Records where an account is in the outreach
 * process as a single fact, written by code at deterministic transition points
 * (the agent's own actions). The transition KEYS below are universal to any
 * outbound motion — they describe what the agent did, not a vertical-specific
 * sales process — so a neutral default is allowed. The customer-facing fact
 * NAME and the per-transition LABELS live here so nothing is hardcoded:
 *   - stage_fact_name: which fact records the stage. Default 'outreach_stage'.
 *   - labels: maps each transition key to the value written. Default: the key.
 *
 * Unset / empty → defaults below. A customer can rename the fact or relabel
 * any stage without a code change.
 */
export type OutreachTransition = 'researched' | 'drafted' | 'contacted' | 'replied';
export interface LifecyclePolicy {
  stage_fact_name?: string;
  labels?: Partial<Record<OutreachTransition, string>>;
}

/**
 * Retention — bounds the two tables that grow unbounded (signals, events).
 * Vertical-neutral and OFF by default: a fresh workspace keeps everything
 * forever until an operator opts in. All deletion is provenance-safe.
 *
 * signal_embedding_ttl_days: once a signal is older than this, null its
 *   embedding vector (kept: row, body_for_embedding, tags, all extracted
 *   facts). Live matching only uses recent signals, and the vector is
 *   recomputable from the body, so this is pure dead-weight reclamation.
 *   0 / unset = never archive.
 *
 * event_ttl_days + prunable_event_actions: delete operational/telemetry
 *   events older than the window whose action is in the list (e.g.
 *   'subscription.matched', 'agent_run_metrics'). prune_events refuses to
 *   delete any event a fact points at, so provenance is safe regardless of
 *   the list. Empty list / unset = delete nothing.
 */
export interface RetentionPolicy {
  signal_embedding_ttl_days?: number;
  event_ttl_days?: number;
  prunable_event_actions?: string[];
}

/**
 * One AI-written search angle. The planner (generateResearchStrategy) authors the
 * query text; the only field a human edits is `enabled`. Shape lives in code, the
 * contents are generated per-workspace from the About text + guidance — nothing
 * vertical-specific is baked here.
 *
 * domain_scope drives the Exa request shape (NOT a free-form category) because Exa's
 * `company`/`people` categories reject date/domain/text filters, while `news` and no
 * category accept them:
 *   - own_site : includeDomains=[entity domain], recency window. The company's own
 *                blog / changelog / launch / case-study pages. Highest-value, no slug
 *                collisions.
 *   - news     : category='news', recency window, includeText=[entity name]. Press /
 *                funding / launch coverage by others.
 *   - open_web : no category, recency window, includeText=[entity name]. Everything else.
 */
export interface ResearchAngle {
  id: string;
  label: string;
  query_template: string;          // uses {entity} and optionally {domain} / {keywords}
  domain_scope: 'own_site' | 'news' | 'open_web';
  recency_days?: number;           // startPublishedDate window; unset = no date filter
  num_results?: number;            // small, default 4
  enabled?: boolean;               // human on/off toggle; unset = enabled
}

/**
 * Research policy. Drives the per-entity deep-research path (researchRunner +
 * entity_research_dispatcher). The AI plans the searches; the human gives high-level
 * guidance and budget. Vertical-neutral: a fresh workspace runs a neutral baseline
 * strategy (see research_strategy.ts) with zero config.
 *
 *   guidance         : plain-English "what should the agent dig up about prospects?".
 *                      Folded into the planner prompt. Default empty.
 *   always_include   : must-have topics/terms the planner must cover. Default empty.
 *   searches_per_run : Exa searches the dispatcher may spend per 4h tick (×6 = daily).
 *                      Caps spend; default DEFAULT_RESEARCH_SEARCHES_PER_RUN. Spent
 *                      top-down across the selection buckets.
 *   selection_mix    : share of the per-run budget each bucket gets. Defaults sum to 1.
 *   strategy         : the AI-generated angles, cached. Regenerated on About/guidance
 *                      change or when stale. Empty/unset = generate lazily.
 */
export interface ResearchPolicy {
  guidance?: string;
  always_include?: string[];
  searches_per_run?: number;
  selection_mix?: { high_value?: number; active_comms?: number; exploration?: number };
  strategy?: ResearchAngle[];
  strategy_generated_at?: string;
}

/**
 * Deep account qualification — the one adaptive multi-step loop in the system.
 * On a high-fit account it researches step by step (search → read a page →
 * follow the relevant thread → identify the buyer → decide the angle) and writes
 * a sourced verdict. Distinct from the cheap single-shot enrich/score path and
 * from the fixed-fan-out research path (researchRunner): this is the expensive,
 * high-value path, so it is OFF by default and only fires autonomously on
 * accounts that already clear min_icp.
 *
 *   enabled         : autonomous trigger on/off. Default false. The chat
 *                     `qualify_account` tool runs on demand regardless of this —
 *                     `enabled` governs only the background trigger.
 *   model           : loop model. Default 'deepseek-v4-pro' (single-shot triage
 *                     stays on Flash). Any model the registry understands works.
 *   max_steps       : hard cap on plan→act→observe iterations. Default 8.
 *   token_budget    : hard cap on total tokens across the run (provider-agnostic
 *                     stop condition, so no price table in code). Default 60000.
 *   min_icp         : account fit floor for the AUTONOMOUS trigger. Default 0.65.
 *   max_empty_steps : stop after this many consecutive empty tool results, to
 *                     kill a loop that's spinning. Default 2.
 */
export interface QualificationPolicy {
  enabled?: boolean;
  model?: string;
  max_steps?: number;
  token_budget?: number;
  min_icp?: number;
  max_empty_steps?: number;
}

export interface PipelineStatus {
  /** ok = last run finished clean; running = a run is in progress; paused = halted on a credit/auth error and waiting for the operator. */
  state: 'ok' | 'running' | 'paused';
  /** One plain-language sentence the operator can act on (only set when paused). */
  reason?: string;
  /** Which provider tripped the pause (deepseek / hunter / explorium / llm). */
  provider?: string;
  paused_at?: string;
  last_run_at?: string;
  last_run?: Record<string, unknown>;
}

export interface WorkspacePolicy {
  // pre-existing fields
  suppression_list?: string[];
  daily_send_cap?: number;
  notify_channels?: string[];
  retention?: RetentionPolicy;

  // new structured sections
  outreach?: OutreachPolicy;
  enrichment?: EnrichmentPolicy;
  drafter?: DrafterPolicy;
  llm?: LLMPolicy;
  routing?: RoutingPolicy;
  scoring?: ScoringPolicy;
  contact_scoring?: ContactScoringPolicy;
  personas?: PersonaPolicy;
  /** Which is_a types get scored. Default ['account']. Add 'contact' to enable contact scoring. */
  scorable_types?: string[];
  hiring_filter?: HiringFilterPolicy;
  lifecycle?: LifecyclePolicy;
  display?: DisplayPolicy;
  research?: ResearchPolicy;
  qualification?: QualificationPolicy;

  /**
   * Live run state the UI shows as a status banner. Written by the advance pass:
   * `ok` after a clean run, `paused` when a provider/LLM credit-or-auth error
   * halted the run. `reason` is one plain sentence the operator can act on.
   */
  pipeline?: PipelineStatus;

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
   *   HUNTER_API_KEY      — Hunter contact provider (contacts.ts)
   *   EXPLORIUM_API_KEY   — Explorium contact provider (contacts.ts)
   * Setting other vars here is fine — they're stored. A forked workspace can paste
   * either contact-provider key here and it's used ahead of process.env.
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

/**
 * Research budget defaults. The dispatcher runs every 4h (6 ticks/day), so the
 * per-run default ×6 sets the daily Exa ceiling. 30/run ≈ 180/day — at ~$0.005/search
 * that's flat against the prior behavior (RESEARCH_FANOUT_LIMIT 25/tick × 1 search).
 */
export const DEFAULT_RESEARCH_SEARCHES_PER_RUN = 30;
export const DEFAULT_SELECTION_MIX = { high_value: 0.55, active_comms: 0.30, exploration: 0.15 } as const;
/** Exa searches each tier spends per entity researched. Exploration grants a cold account 1. */
export const TIER_ANGLE_COUNT = { hot: 3, default: 1, cold: 0 } as const;

export const DEFAULT_POLICY: Required<Pick<WorkspacePolicy, 'outreach' | 'enrichment' | 'drafter' | 'llm' | 'routing' | 'scoring'>> & WorkspacePolicy = {
  outreach: {
    override_to: null,
    from_email: 'onboarding@resend.dev',
    banned_phrases: [],
  },
  enrichment: {
    contact_provider: 'none',
    coalesce_window_min: 60,
  },
  drafter: {
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
    research: { ...(raw.research ?? {}) },
    env: { ...(raw.env ?? {}) },
  };
}

/**
 * Read the live pipeline status the UI banner shows. Returns null when the
 * workspace has never run (no status written yet). Reads the raw policy so it
 * doesn't pull the default-merge machinery in getPolicy.
 */
export async function getPipelineStatus(supabase: SupabaseClient, workspace_id: string): Promise<PipelineStatus | null> {
  const r = await supabase.from('workspaces').select('policy').eq('id', workspace_id).maybeSingle();
  const raw = (r.data?.policy ?? {}) as WorkspacePolicy;
  return raw.pipeline ?? null;
}

/**
 * Replace the workspace's pipeline status (not a deep merge — the status object
 * fully describes current state, so writing {state:'ok', ...} clears a prior
 * pause's reason/provider). Read-modify-write on the raw policy so the rest of
 * the policy is preserved untouched. Callers: the advance pass (ok/paused) and
 * the Continue action (clears the pause).
 */
export async function setPipelineStatus(supabase: SupabaseClient, workspace_id: string, status: PipelineStatus): Promise<void> {
  const r = await supabase.from('workspaces').select('policy').eq('id', workspace_id).maybeSingle();
  const raw = (r.data?.policy ?? {}) as WorkspacePolicy;
  await supabase.from('workspaces').update({ policy: { ...raw, pipeline: status } }).eq('id', workspace_id);
}

/**
 * Qualification config with defaults applied. The autonomous trigger reads
 * `enabled` + `min_icp`; the loop runner reads `model` / `max_steps` /
 * `token_budget` / `max_empty_steps`. All overridable per workspace via
 * policy.qualification — vertical-neutral, safe to run with zero config.
 */
export const DEFAULT_QUALIFICATION: Required<QualificationPolicy> = {
  enabled: false,
  model: 'deepseek-v4-pro',
  max_steps: 8,
  token_budget: 60000,
  min_icp: 0.65,
  max_empty_steps: 2,
};

export function resolveQualification(policy: WorkspacePolicy): Required<QualificationPolicy> {
  return { ...DEFAULT_QUALIFICATION, ...(policy.qualification ?? {}) };
}
