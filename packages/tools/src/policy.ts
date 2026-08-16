/**
 * WorkspacePolicy — every customer-varying value lives here, on workspaces.policy.
 * Substrate (events, facts, gates, scoring framework) stays in code; this is config.
 *
 * Defaults are vertical-neutral: a brand-new workspace can run safely without any
 * policy fields set. The backfill script preserves the existing dog-food values
 * for the original workspace.
 */
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DisplayPolicy } from './fact_groups.ts';

export interface OutreachPolicy {
  override_to?: string | null;          // null/undefined = send to real recipient
  from_email?: string;                  // default DEFAULT_POLICY.outreach.from_email
  banned_phrases?: string[];            // stacks on top of code-level defaults
  resend_api_key?: string;              // workspace-scoped; secrets table later
}

export interface EnrichmentPolicy {
  /**
   * Properties of a business that never change, asserted once and then read,
   * instead of being re-derived from prose on every scoring call.
   *
   * The case that forced this: the out-of-scope veto asks "is their video live
   * only, with no on-demand catalog". OVI Technologies describes itself as a
   * "sub second live streaming environment" and also carries an imported
   * `product: Film/TV Streaming` tag. Two facts, opposite answers, so the
   * rubric correctly refused to veto and a live-only account scored 0.95. No
   * wording change fixes that, because the contradiction is in the evidence.
   * Asking the question once and storing the answer does.
   *
   * Contents are entirely workspace config. The SHAPE is here; which
   * properties matter, what they are called and what values they may take
   * belong to the customer, because "live versus on-demand" means nothing
   * outside one vertical. Empty / unset = the backfill does nothing, which is
   * the default for every workspace.
   *
   *   predicate : the fact name to assert (e.g. a delivery mode, a business
   *               model). One fact per account per predicate.
   *   question  : plain-English question the model answers from the account's
   *               facts. Write it so the answer is one of `values`.
   *   values    : the allowed answers. Anything else is discarded rather than
   *               stored, so a model that improvises writes nothing.
   */
  stable_attributes?: Array<{ predicate: string; question: string; values: string[] }>;
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
   * Max new outreach drafts the advance pass creates per daily run. Bounds
   * both approval-queue size and drafter LLM spend. Default 12.
   */
  max_drafts_per_run?: number;
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
   * Signal types the coalesce window applies to. Unset = every type, which is
   * the behaviour this knob was carved out of.
   *
   * The rationale above only holds for a burst of near-identical items: N job
   * posts really are one hiring trend, so reading the first is enough. It does
   * NOT hold for a burst of distinct documents. Measured on Sudden over 14 days:
   * 1765 signals were coalesced away and 1733 of them (98%) were
   * `research_result`, not `hiring_post` — and 196 of 272 sampled carried a
   * DISTINCT source url. Those are different articles, already past the
   * embedding near-dup check that runs before a signal is created, and only the
   * first of each research burst is ever read into facts. The rest are dropped
   * unread, which starves evidence_depth and leaves the drafter without a
   * trigger.
   *
   * Left defaulting to today's behaviour on purpose: enriching every article in
   * a burst instead of one is a real multiple on enrichment spend (that path is
   * already the largest token consumer), so it is a budget decision, not a bug
   * fix to apply silently. Set e.g. ["hiring_post"] to keep collapsing ATS
   * bursts while letting every distinct research document through.
   */
  coalesce_signal_types?: string[];
  /**
   * Fact-level near-dup threshold. When the enricher proposes a fact, its
   * object_text is embedded and compared (cosine) against the entity's active
   * facts with the SAME predicate; a match at or above this value is a reworded
   * restatement and is skipped (content_hash only catches byte-identical). 0.975
   * is derived from real data: the highest cosine between two GENUINELY-DISTINCT
   * same-predicate facts observed on a live book was 0.9697 ("50,000+" vs
   * "55,000+ live events"), so 0.975 sits above every distinct pair and never
   * drops a real fact. Same-predicate only; fail-open on embed error. Default
   * 0.975. Set 0 to disable.
   */
  fact_dedup_sim?: number;
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
   * instead of a full cold email — or, when `templates` below is non-empty, a
   * template-driven DM.
   */
  outreach_channel?: 'email' | 'linkedin';

  /**
   * Message templates for the LinkedIn DM drafter. Contents are workspace
   * config: real names, stats, and links live HERE, never in shared code.
   * Empty = the generic connection-request formula.
   */
  templates?: Array<{
    id: string;
    label: string;
    /** Who this template targets. The drafter matches the recipient's role to this. */
    audience: string;
    /** Exemplar message, rendered verbatim as a style anchor. */
    body: string;
    /**
     * The argument this exemplar's question makes, in one plain sentence
     * ("unit cost scales one to one with volume"). Audience picks WHO the
     * message is for; this names WHAT it argues, which is the thing the model
     * kept copying. Before every draft, the angle picker reads this list
     * alongside the problem it chose for the account and names the templates
     * that argue the same thing; those render their anatomy with the body
     * withheld, so the shape still teaches and the argument cannot be lifted.
     * Unset = the exemplar always renders in full, which is the old behaviour.
     */
    angle?: string;
    /** Structure breakdown (Trigger/Think/Cred/Talk) shown to the model. */
    anatomy?: string;
    /** Bump message for a future follow-up touch. Stored, not drafted yet. */
    follow_up?: string;
    /** Process notes for the human at send time. Never rendered to the LLM. */
    notes?: string;
    /** Default true. */
    enabled?: boolean;
  }>;
  /** Drafting rules rendered verbatim into the template-driven DM prompt. */
  message_rules?: string[];
  /** Character target for the DM body. Default 400 when templates are present. */
  char_budget?: number;
  /**
   * How old a trigger may be before the drafter refuses to build on it. How fast
   * "recent" goes stale depends on the customer's market, so it is a knob, not a
   * constant: a funding-driven book moves in weeks, an infrastructure book in
   * quarters. Default 90 days.
   */
  trigger_max_age_days?: number;
  /**
   * How recent an event must be to LEAD a message as its trigger ("saw you
   * launched X"). Older events (up to trigger_max_age_days) can still serve as
   * evidence for a theme-led message, but never get presented as news. Like
   * trigger_max_age_days, how fast news goes stale is a property of the
   * customer's market. Default 14 days.
   */
  trigger_fresh_days?: number;
  /** Connection-request note template. For manual use at CR time; not rendered. */
  cr_note?: string;

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
  /**
   * Conditions that make an account unsellable no matter how well it matches
   * the ICP on paper: traffic the product can't serve yet, a business that
   * resells what we sell instead of buying it, a market we don't ship to.
   * One plain sentence each, written so a reader can check it against the
   * account's facts.
   *
   * Read by BOTH the scorer and the drafter, like pain_points/value_props
   * above. In the scorer it is a veto, not a weighted dimension: a matched
   * condition forces icp_total to 0 regardless of the other sub-scores, since
   * an account we cannot serve is not "a slightly worse fit" — it is no fit.
   * Averaging it would leave a textbook-industry match above the draft bar,
   * which is exactly how a live-only video vendor got drafted at icp_fit 0.87.
   * In the drafter it is a hard stop that routes to request_gate, which covers
   * accounts already scored before a condition was added.
   *
   * What belongs here is a property of the product, so it is config and starts
   * empty. Default: no conditions, nothing is vetoed.
   */
  out_of_scope?: string[];
  /** Tone keywords baked into the prompt: ["casual", "direct", "concrete"]. */
  tone_keywords?: string[];
  /**
   * Language every outgoing message is written in. Was `Write in English,
   * always` hardcoded in the shared craft block, which is a workspace fact and
   * not craft — a customer selling into Germany wants German even when the
   * prospect's own site happens to be in English. The rule itself stays in code
   * (the model must not code-switch to match the source it just read); only the
   * language is config. Default 'English', so nothing changes for a workspace
   * that never sets it.
   */
  outreach_language?: string;
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
  /**
   * Ceiling on output tokens per LLM call, by behavior. Any key omitted falls
   * back to DEFAULT_MAX_OUTPUT_TOKENS.
   *
   * This is config rather than a constant because the right ceiling depends on
   * how much the model is being asked to read, which varies per customer: the
   * enricher and drafter prompts carry the account's active facts, and an
   * account with 139 of them makes the model reason for far longer than one
   * with 6.
   *
   * A ceiling that is too LOW is not a saving. The model never sees it, so it
   * writes the same answer either way; the ceiling only decides where the
   * answer gets cut off. A cut-off answer is unparseable JSON, and chatComplete
   * responds by re-sending the whole prompt at 3x the budget, so an under-set
   * ceiling means paying for one thrown-away call plus a second full one.
   */
  max_output_tokens?: { enricher?: number; drafter?: number; scoring?: number; claim_poster?: number };
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
  /**
   * REMOVED. Was an evidence_depth ceiling above which research stopped firing.
   * It counted facts that arrived with the record (CSV import columns) as if we
   * had researched them, so any workspace importing 3+ columns per account
   * switched its own research off on day one. The research cooldown is the
   * limiter now. Left here as a comment so a stale value in a stored policy
   * reads as intentionally ignored rather than a dropped field.
   */
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
 *   - social   : includeDomains=policy.research.social_domains, recency window,
 *                includeText=[entity name]. Posts, talks, interviews by the
 *                company's execs — the trigger material outreach templates
 *                reference. Inert until social_domains is configured. Results
 *                are NOT own-site-trusted: they pass the same-name
 *                disambiguation gate, which matters most on social hosts where
 *                name collisions are worst.
 */
export interface ResearchAngle {
  id: string;
  label: string;
  query_template: string;          // uses {entity} and optionally {domain} / {keywords}
  domain_scope: 'own_site' | 'news' | 'open_web' | 'social';
  recency_days?: number;           // startPublishedDate window; unset = no date filter
  num_results?: number;            // small, default 4
  enabled?: boolean;               // human on/off toggle; unset = enabled
  /**
   * Which research-brief question this angle exists to answer (a `BriefQuestion.id`).
   * The planner is required to set it, so every search is traceable to something
   * the workspace actually needs to know, and an angle whose pages never answer
   * its question can be spotted and cut instead of quietly re-run forever.
   * Unset on angles planned before the brief existed; those still run.
   */
  answers?: string;
  /**
   * When this angle's SEARCH last changed, so its track record is read against
   * the query that actually ran.
   *
   * The record is filed under the angle id, and the id is deliberately kept when
   * the planner rewrites a query — that is what stops a reworded angle starting
   * from zero every regeneration. But the two rules collide: the angle that
   * fetched 183 pages and kept none was rewritten from a LinkedIn search into a
   * news search, and without this it inherits the failing record of a query that
   * no longer exists. The next planner run would be told a brand-new query
   * "CANNOT work as written", and the scorecard would read as though the fix had
   * not landed.
   *
   * Set by persistResearchStrategy when query_template or domain_scope changes,
   * carried forward untouched when they do not. Unset means "count everything",
   * which is right for angles that predate this.
   */
  record_since?: string;
}

/**
 * One question in the workspace's research brief — what the agent must find out
 * about a prospect before it may write to them. See research_brief.ts for how
 * these are generated and how every stage uses them.
 *
 * `id` is also the predicate namespace: question `scale` owns `scale.*`. That is
 * what keeps the fact vocabulary from sprawling, since the prefix is fixed by the
 * brief and only the suffix is the extractor's to choose.
 */
export interface BriefQuestion {
  id: string;
  label: string;
  question: string;
  /** One line on why this seller cares. Rendered into the gate + enricher prompts. */
  why?: string;
  /** 'event' needs something dated to have happened; 'state' describes how they stand. */
  kind?: 'event' | 'state';
  enabled?: boolean;
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
 *   resolve_domains  : when an entity has no attributes.domain, spend the first
 *                      budgeted search on resolving it (one "official website"
 *                      lookup gated by the name-match guard) before running
 *                      angles. Default true; it spends from the existing
 *                      research budget, no new spend class.
 *   domain_backfill_per_day : how many domainless accounts the daily backfill
 *                      cron may attempt to resolve (one Exa search each,
 *                      same guard as resolve_domains). 0 / unset = off.
 *                      Each attempt spends real search credit, so the
 *                      operator sets the pace explicitly.
 *   resolve_aliases  : once an account has a domain but no aliases, spend one
 *                      budgeted search reading its own site for the other names
 *                      its coverage runs under (the press calls Crazy Maple
 *                      Studio "ReelShort"). Without them the name gate drops
 *                      every genuine article about such a company. Default true;
 *                      spends from the existing research budget. Guards are in
 *                      aliases.ts and abstain rather than guess.
 *   alias_backfill_per_day : how many accounts the daily backfill may read for
 *                      aliases (one Exa search + one model call each). 0 /
 *                      unset = off, same as domain_backfill_per_day — accounts
 *                      imported before this existed are only swept when the
 *                      operator sets a pace.
 *   social_domains   : hosts the `social` domain_scope searches within (e.g. a
 *                      professional network the workspace's buyers post on).
 *                      Empty/unset = social angles are skipped entirely. The
 *                      contents are workspace config, never code.
 *   exclude_domains  : hosts the `news` / `open_web` angles must never return,
 *                      for repost aggregators whose own timestamp hides the
 *                      original byline and defeats every date check downstream.
 *                      Empty/unset by default and never populated in code.
 *   contact_signal_share : share of searches_per_run spent searching what
 *                      linked PEOPLE (not companies) have posted publicly,
 *                      taken off the top before the account buckets above run
 *                      on the remainder — same total spend, just some of it
 *                      redirected. 0/unset = off (default), so no existing
 *                      workspace's spend changes until this is turned on.
 *   contact_signal_account_icp : a contact is only eligible once their account
 *                      clears this score. Unset = reuse
 *                      policy.routing.enrich_contacts_account_icp (0.6
 *                      default), so there's one bar to reason about, not two.
 *   contact_signal_cadence_days : how often an eligible contact gets
 *                      re-searched. People post far less often than companies
 *                      publish, so this runs independently of the account
 *                      tier cadences above. Default 3.
 *   contact_signal_max_age_days : freshness floor for a contact's own posts.
 *                      Default 60 (vs 30 for company research) — same
 *                      reasoning as the cadence: people post less often, a
 *                      tighter floor would starve real results.
 */
export interface ResearchPolicy {
  guidance?: string;
  always_include?: string[];
  searches_per_run?: number;
  /**
   * Hours between research passes per tier. Any key omitted falls back to
   * DEFAULT_TIER_CADENCE_HOURS.
   *
   * This is config rather than a constant because the right cadence depends on
   * how big the book is, which varies per customer: a 200-account book can
   * afford to revisit its best accounts every day, a 2,000-account one cannot.
   *
   * Measured on a 2,243-account book before the default moved from 24h to 96h:
   * yield held between 0.64 and 0.97 kept pages per search through roughly the
   * 7th visit in a month, then fell off a cliff — 0.33 on the 8th, 0.26 on the
   * 9th, 0.22 from the 10th on. At a 24h cadence the heaviest accounts were
   * getting 16-21 passes a month, so about a third of the entire search budget
   * was being spent past that cliff. 96h lands at ~7 passes, which keeps the
   * yield and returns the rest of the budget to accounts never looked at.
   *
   * The existing yield backoff still multiplies whatever is set here.
   */
  tier_cadence_hours?: { hot?: number; default?: number; cold?: number };
  /**
   * Ceiling on how far the cadence stretches for an account whose research keeps
   * coming back with nothing. Set 1 (or 0) to switch the behavior off entirely.
   *
   * The older backoff next to it reads signal_strength — what we believe about
   * an account. This one reads what the last few searches actually returned,
   * which is a different thing: an account can score well off imported facts and
   * still have nothing findable about it on the web. On the Sudden book 60% of
   * research runs created zero facts and those accounts came back around on the
   * same cadence as the productive ones.
   *
   * Two empty runs in a row is the trigger (one is noise), then the multiplier
   * tracks the run count up to this cap: 2 empties -> 2x, 3 -> 3x, 4 or more ->
   * capped here. At the 96h hot default that is 8, 12 then 16 days. One pass
   * that creates a fact resets it. Engaged accounts never back off.
   *
   * It does not stack with the signal backoff — the dispatcher takes whichever
   * of the two is larger. Multiplying them would put a cold, quiet account on a
   * 360-day cadence, which is "never" wearing a number.
   */
  empty_run_backoff_max?: number;
  selection_mix?: { high_value?: number; active_comms?: number; exploration?: number };
  strategy?: ResearchAngle[];
  strategy_generated_at?: string;
  /**
   * The research brief — the questions every stage of research shares. Cached
   * like `strategy`: regenerated when stale or when About/guidance changes.
   * Empty/unset falls back to the neutral BASELINE_BRIEF, so a workspace that
   * has configured nothing still gets a working brief.
   */
  brief?: BriefQuestion[];
  brief_generated_at?: string;
  /**
   * Hash of the About / guidance / always_include / pains the brief was written
   * from. The brief is regenerated when this changes, and NOT on a timer: a
   * question id is a permanent predicate namespace, so re-planning it on a
   * schedule would rename slots and orphan every fact filed under the old name.
   */
  brief_input_hash?: string;
  resolve_domains?: boolean;
  domain_backfill_per_day?: number;
  resolve_aliases?: boolean;
  alias_backfill_per_day?: number;
  social_domains?: string[];
  /**
   * Hosts the name-searched angles (`news`, `open_web`) must never return.
   *
   * For content farms and repost aggregators: sites that paste someone else's
   * article under their own newer timestamp. They defeat every date defence we
   * have, because the date on the page IS the date that copy was posted, so
   * nothing downstream can tell it from a real byline. Observed live: a
   * FloSports/NCAA story published 2025-03-28 reached the book through a user
   * repost stamped 2026-07-28, and four facts were extracted from it as if the
   * deal were ten days old.
   *
   * Empty/unset by default, and it stays that way. Which hosts are junk depends
   * on what a workspace sells and where its buyers publish, so the contents are
   * workspace config and never code.
   *
   * Not applied to `own_site` or `social`, which already restrict results to an
   * explicit allowlist of hosts; nothing else can get in for an exclusion to
   * remove.
   */
  exclude_domains?: string[];
  contact_signal_share?: number;
  contact_signal_account_icp?: number;
  contact_signal_cadence_days?: number;
  contact_signal_max_age_days?: number;
  // Freshness controls for the per-account research path, all scopes including
  // own_site (only an UNDATED result is exempt — an evergreen page with no
  // byline; a dated result is held to the floor no matter which domain it's on).
  //   max_age_days         : hard floor. A result whose source published_at is
  //                          older than this is dropped before it becomes a
  //                          signal. Default 30.
  //   decay_half_life_days : signal magnitude halves every N days of source age,
  //                          so an older-but-passing source scores lower than a
  //                          fresh one. Default 90.
  max_age_days?: number;
  decay_half_life_days?: number;
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
  /**
   * What the pause blocks. 'contacts' = only contact lookups are stopped (drafting
   * of accounts that already have a reachable contact continues on schedule);
   * 'research' = only the Exa research loop is stopped (search provider out of
   * credit — scoring, contact pulls, and drafting all continue on schedule);
   * 'all' = the whole advance pass is stopped (LLM provider is down/broke).
   * Absent on old rows — treated as 'all'.
   */
  scope?: 'contacts' | 'research' | 'all';
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
   * Operator alerts (pause emails, RED health sweeps — see notify.ts).
   * `email` overrides the default recipient (the workspace owner's login
   * email). Needed when the login address differs from the inbox the operator
   * reads, or while Resend runs in testing mode and can only deliver to the
   * Resend account's own address.
   */
  alerts?: { email?: string };

  /**
   * Daily digest + spend reporting (see report.ts and daily_digest.ts).
   * `daily_email` opts the workspace into one summary email per day covering
   * the last 24h: score moves with their reasons, drafts written, approvals
   * waiting, spend estimate. Recipient/key resolution is sendOwnerAlert's.
   * `pricing` overrides the provider list prices the spend estimate uses.
   */
  report?: {
    daily_email?: boolean;
    pricing?: {
      models?: Record<string, { input: number; cached: number; output: number }>;
      exa_per_search?: number;
      exa_per_content_page?: number;
      exa_avg_pages_per_search?: number;
      hunter_per_search?: number;
    };
  };

  /**
   * Fingerprint of the fields scoring reads (icp/about/persona + scoring policy
   * sections), maintained by ensureScoringConfigState. `changed_at` moves ONLY
   * when one of those fields actually changes — unlike workspaces.updated_at,
   * which bumps on every policy write (e.g. the daily pipeline-status write).
   * The rescore cron and skip-when-stale guards compare score timestamps
   * against this, so routine policy writes can't trigger full-book rescores.
   */
  scoring_config_state?: { hash: string; changed_at: string };

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

/**
 * Default hours between research passes per tier. See
 * ResearchPolicy.tier_cadence_hours for why hot is 96 and not 24.
 */
export const DEFAULT_TIER_CADENCE_HOURS = { hot: 96, default: 24 * 7, cold: 24 * 30 } as const;

/** Merge a workspace's tier cadence over the defaults, ignoring junk values. */
export function resolveTierCadenceHours(
  policy: WorkspacePolicy,
): { hot: number; default: number; cold: number } {
  const set = policy.research?.tier_cadence_hours ?? {};
  const pick = (k: 'hot' | 'default' | 'cold') => {
    const v = set[k];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : DEFAULT_TIER_CADENCE_HOURS[k];
  };
  return { hot: pick('hot'), default: pick('default'), cold: pick('cold') };
}

/**
 * Default ceiling on the empty-run backoff multiplier. See
 * ResearchPolicy.empty_run_backoff_max for the yield data behind it.
 */
export const DEFAULT_EMPTY_RUN_BACKOFF_MAX = 4;

/** Consecutive empty research runs before the cadence starts stretching. */
export const EMPTY_RUN_BACKOFF_TRIGGER = 2;

/**
 * Cadence multiplier for an account whose last `emptyRuns` research passes all
 * created nothing. 1 means "no change". Exported so the dispatcher and its
 * assertions read the same ladder.
 */
export function emptyRunBackoff(emptyRuns: number, policy: WorkspacePolicy): number {
  const raw = policy.research?.empty_run_backoff_max;
  const max = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_EMPTY_RUN_BACKOFF_MAX;
  if (max <= 1) return 1; // switched off for this workspace
  if (!Number.isFinite(emptyRuns) || emptyRuns < EMPTY_RUN_BACKOFF_TRIGGER) return 1;
  return Math.min(Math.floor(emptyRuns), max);
}

/**
 * Default output-token ceiling per LLM behavior. See LLMPolicy.max_output_tokens
 * for why this is config, and why a low ceiling costs money rather than saving it.
 *
 * Set from what the calls actually emit. Measured over 30 days of
 * `agent_run_metrics`, against the ceilings that were in force at the time:
 *
 *   behavior   old ceiling   runs    p50    p90    p99    max    re-sent
 *   scoring          350     2295    899   1751   3482   3995     99.6%
 *   enricher        1200     1674   1840   3283   3905   3997     69.8%
 *   drafter         3000      103   1945   4253   7253   7595     17.5%
 *
 * "re-sent" is the share of runs whose recorded output exceeds their own
 * ceiling, which can only happen on chatComplete's retry. So essentially every
 * scoring call in the system was being billed twice, and the scorer is the
 * busiest LLM caller there is.
 *
 * The scoring and enricher tails are censored: the retry ran at 4000 and both
 * maxima sit just under it, so their real p99 is unknown. The drafter's is not
 * censored (its retry had room to 9000) and it runs to 3.9x its own median.
 * Applying that ratio to the other two is what puts the enricher at 8000 rather
 * than at the 3905 its clipped sample suggests.
 *
 * Raising a ceiling cannot make a call that already fits cost more: the model is
 * not told the number, so a run that finishes in 900 tokens still bills 900.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = { enricher: 8000, drafter: 8000, scoring: 4000, claim_poster: 2000 } as const;

/** Merge a workspace's per-behavior output ceiling over the defaults, ignoring junk values. */
export function resolveMaxOutputTokens(
  policy: WorkspacePolicy,
  behavior: keyof typeof DEFAULT_MAX_OUTPUT_TOKENS,
): number {
  const v = (policy.llm?.max_output_tokens ?? {})[behavior];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_OUTPUT_TOKENS[behavior];
}

export const DEFAULT_SELECTION_MIX = { high_value: 0.55, active_comms: 0.30, exploration: 0.15 } as const;
/** Exa searches each tier spends per entity researched. Exploration grants a cold account 1. */
export const TIER_ANGLE_COUNT = { hot: 3, default: 1, cold: 0 } as const;

/**
 * Single source of truth for the research dispatcher's cadence — used both as
 * the Inngest cron schedule (entity_research_dispatcher.ts) and by the
 * pipeline-status API to compute "next run" for the banner, so the two can't
 * drift apart.
 */
export const RESEARCH_DISPATCH_CRON = '0 */4 * * *';

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
 * Actions that mean "the pipeline actually did something", newest of which backs
 * the banner's "ran X ago".
 *
 * Why this is not `pipeline.last_run_at`: that field is written ONLY by the
 * daily advance pass (advance_accounts.ts), and the research dispatcher
 * deliberately passes the old value through rather than updating it. So a
 * workspace could research six accounts, create signals and write facts, and the
 * banner would still report the advance pass's timestamp from hours earlier.
 * Observed live: research completed 10 minutes ago while the banner read "ran 5h
 * ago". The banner says "Pipeline", so it has to mean the whole pipeline.
 *
 * Deliberately excludes the bookkeeping-heavy actions. `supersede_fact` and
 * `rescore_noop` fire in the hundreds during a routine rescore, so including
 * them would make the banner read "ran 0m ago" more or less permanently and it
 * would stop carrying information.
 */
export const PIPELINE_ACTIVITY_ACTIONS = [
  'research_completed',
  'research_error',
  'create_signal',
  'assert_fact',
  'post_to_channel',
  'contacts_completed',
  'domain_resolve_completed',
] as const;

export interface PipelineActivity {
  at: string;
  action: string;
}

/**
 * When the pipeline last did real work, and what it was. One indexed read
 * (events_workspace_action_time_idx, migration 0047). Null when the workspace
 * has never done any of it.
 */
export async function getPipelineActivity(
  supabase: SupabaseClient,
  workspace_id: string,
): Promise<PipelineActivity | null> {
  const r = await supabase
    .from('events')
    .select('action, created_at')
    .eq('workspace_id', workspace_id)
    .in('action', PIPELINE_ACTIVITY_ACTIONS as unknown as string[])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const row = r.data as { action: string; created_at: string } | null;
  return row ? { at: row.created_at, action: row.action } : null;
}

/**
 * Replace the workspace's pipeline status (not a deep merge — the status object
 * fully describes current state, so writing {state:'ok', ...} clears a prior
 * pause's reason/provider). Read-modify-write on the raw policy so the rest of
 * the policy is preserved untouched. Callers: the advance pass (ok/paused) and
 * the Continue action (clears the pause).
 *
 * Side effect: on the not-paused → paused edge, emails the workspace owner the
 * same reason sentence the banner shows. The edge check is the dedupe — a
 * paused run re-writing its standing status (retry loops, partial runs) stays
 * on the paused side and sends nothing, so one pause episode = one email.
 */
export async function setPipelineStatus(supabase: SupabaseClient, workspace_id: string, status: PipelineStatus): Promise<void> {
  const r = await supabase.from('workspaces').select('policy').eq('id', workspace_id).maybeSingle();
  const raw = (r.data?.policy ?? {}) as WorkspacePolicy;
  await supabase.from('workspaces').update({ policy: { ...raw, pipeline: status } }).eq('id', workspace_id);
  if (status.state === 'paused' && raw.pipeline?.state !== 'paused') {
    try {
      // Lazy import keeps policy.ts free of a static cycle with notify.ts.
      const { notifyPipelinePaused } = await import('./notify.ts');
      const sent = await notifyPipelinePaused(supabase, workspace_id, status);
      console.log(`[pipeline] pause alert: ${sent.ok ? `emailed ${sent.to}` : (sent.skipped ?? sent.error)}`);
    } catch (e) {
      // Alerting is best-effort; the status write above already succeeded.
      console.error('[pipeline] pause alert failed:', e instanceof Error ? e.message : String(e));
    }
  }
}

/**
 * Refresh the workspace's scoring-config fingerprint and return the timestamp
 * of the last REAL scoring-config change (ISO string).
 *
 * Hashes exactly the fields entity/contact scoring reads: icp, about, persona,
 * policy.scoring, policy.contact_scoring, policy.personas, policy.scorable_types.
 * When none of these changed, re-scoring an entity with no new facts is a
 * guaranteed no-op, so staleness checks must key off this — not
 * workspaces.updated_at, which bumps on every policy write.
 *
 * First sighting (no stored state) stamps changed_at at epoch so deploying this
 * never triggers a full-book rescore; a later hash change stamps now.
 */
export async function ensureScoringConfigState(
  supabase: SupabaseClient,
  workspace_id: string,
): Promise<string> {
  const r = await supabase.from('workspaces').select('icp, about, persona, policy').eq('id', workspace_id).maybeSingle();
  if (!r.data) return new Date(0).toISOString();
  const row = r.data as { icp?: unknown; about?: string; persona?: unknown; policy?: WorkspacePolicy | null };
  const pol = (row.policy ?? {}) as WorkspacePolicy;
  const hash = createHash('sha256').update(JSON.stringify({
    icp: row.icp ?? null,
    about: row.about ?? null,
    persona: row.persona ?? null,
    scoring: pol.scoring ?? null,
    contact_scoring: pol.contact_scoring ?? null,
    personas: pol.personas ?? null,
    scorable_types: pol.scorable_types ?? null,
  })).digest('hex').slice(0, 24);
  const stored = pol.scoring_config_state;
  if (stored?.hash === hash) return stored.changed_at;
  const changed_at = stored ? new Date().toISOString() : new Date(0).toISOString();
  await supabase.from('workspaces').update({
    policy: { ...pol, scoring_config_state: { hash, changed_at } },
  }).eq('id', workspace_id);
  return changed_at;
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
