import { z } from 'zod';

const UuidSchema = z.string().uuid();

// Each schema mirrors the payload shape that `record_event` expects for the matching action.
// MCP tool names are kebab-case-friendly; we keep snake_case here to match the SQL.

export const CreateWorkspaceSchema = z.object({
  name: z.string().min(1),
  persona: z.record(z.unknown()).default({}),
  icp: z.record(z.unknown()).default({}),
  budget_cents: z.number().int().positive().default(1000),
  policy: z.record(z.unknown()).default({}),
});

export const SetWorkspacePolicySchema = z.object({
  persona: z.record(z.unknown()).optional(),
  icp: z.record(z.unknown()).optional(),
  budget_cents: z.number().int().positive().optional(),
  policy: z.record(z.unknown()).optional(),
});

export const CreateAccountSchema = z.object({
  name: z.string().min(1),
  attributes: z.record(z.unknown()).default({}),
});

export const CreateContactSchema = z.object({
  name: z.string().min(1),
  account_entity_id: UuidSchema.optional(),
  attributes: z.record(z.unknown()).default({}),
});

// Generic entity creation for kinds beyond account/contact (e.g. opportunity).
// The kind is asserted as the entity's is_a fact. No channel is created.
export const CreateEntitySchema = z.object({
  name: z.string().min(1),
  kind: z.string().min(1),
  attributes: z.record(z.unknown()).default({}),
});

export const AssertFactSchema = z.object({
  subject_entity: UuidSchema,
  predicate: z.string().min(1),
  object_text: z.string().optional(),
  object_entity: UuidSchema.optional(),
  confidence: z.number().min(0).max(1).default(1.0),
  // Cite chain v2: bind the fact to the signal that triggered its assertion.
  // Idempotent — on content-hash dedup, the existing fact's signal_id is
  // preserved (callTool only sets when currently null).
  signal_id: UuidSchema.optional(),
  // When the thing this fact records actually happened (ISO). Omitted for the
  // majority of facts, which describe how a company stands rather than
  // something it did. Written by the enricher, which is the only stage that
  // reads the page, and by add_note when a person says when something happened.
  // Same idempotency as signal_id: on a content-hash dedup the date the fact
  // first carried is kept.
  happened_at: z.string().optional(),
});

/**
 * What a person knows that no search can buy.
 *
 * Everything else in this system learns about a company by reading a page. The
 * one input that beats every search is the founder saying "I met their VP Eng
 * at the conference, they are re-tendering their CDN in Q1" — first-hand, not
 * published anywhere, and the strongest reason to write to that account this
 * month.
 *
 * `happened_at` is the field that matters. A message needs a dated event to
 * open on, so a note WITH a date can become the reason we write, and a note
 * without one is background that raises the score and informs the argument.
 * Both are useful; only the first can anchor a message.
 */
export const AddNoteSchema = z.object({
  entity_id: UuidSchema,
  /** What the person knows, in their own words. */
  note: z.string().min(1),
  /** When the thing described happened (ISO). Omit for standing background. */
  happened_at: z.string().optional(),
  /** Where it came from: "call with their VP Eng", "NAB", "intro from Dave". */
  source: z.string().optional(),
});

/**
 * What is waiting on a person right now.
 *
 * An outside agent could approve or reject a pending decision (decide_gate) but
 * had no way to find out one existed, so "what needs me today" was unanswerable
 * without opening the web app. health_check returns a count, which tells you
 * something is stuck and nothing about what.
 */
export const ListApprovalsSchema = z.object({
  /** Cap the rows returned. */
  limit: z.number().int().positive().max(200).default(50),
  /** Only approvals of this kind, e.g. 'outreach_send'. Omit for all. */
  policy: z.string().optional(),
});

/**
 * Go and find decision-makers at an account, now, through whichever contact
 * provider the workspace configured.
 *
 * Synchronous and metered: it spends provider credit and respects the
 * workspace's monthly cap. The daily pass already does this on its own
 * schedule; this is for an agent working one account on demand.
 */
export const PullContactsSchema = z.object({
  entity_id: UuidSchema,
});

/**
 * Go and research one account now, instead of waiting for its turn.
 *
 * The dispatcher already picks accounts on a cadence set by score, so this is
 * for the case the cadence cannot serve: an agent working one company and
 * wanting current facts about it before it writes.
 *
 * Asynchronous by nature. It queues the work and returns; the searches run in
 * the background and land as facts a few minutes later. Costs search credit.
 */
export const ResearchAccountSchema = z.object({
  entity_id: UuidSchema,
  /**
   * How many of the workspace's search angles to run. Each one is a paid
   * search. Omit to let the workspace's own tier budget decide.
   */
  angle_count: z.number().int().positive().max(10).optional(),
  /** Why this is being researched now — recorded on the run for the audit. */
  reason: z.string().optional(),
});

export const SupersedeFactSchema = AssertFactSchema.extend({
  supersedes: UuidSchema,
});

// Embedding is computed by the tool wrapper, not passed by the caller.
export const CreateSignalSchema = z.object({
  entity_id: UuidSchema,
  type: z.string().min(1),
  magnitude: z.number().min(0).max(1).default(0.5),
  body_for_embedding: z.string().min(1),
  structured_tags: z.record(z.unknown()).default({}),
  // Optional idempotency key. When set, create_signal no-ops (no embed, no
  // insert) if a signal with the same entity + type + key already exists in the
  // recent window. The key is also stamped into structured_tags for the lookup.
  dedup_key: z.string().optional(),
});

export const CreateSubscriptionSchema = z.object({
  owner_kind: z.enum(['agent', 'user']),
  owner_id: z.string().min(1),
  name: z.string().min(1),
  semantic_query: z.string().min(1),
  structured_filter: z.record(z.unknown()).default({}),
  threshold: z.number().min(0).max(1).default(0.75),
  action_on_match: z.string().default('agent.run'),
});

export const PostToChannelSchema = z.object({
  channel_id: UuidSchema,
  kind: z.enum(['claim', 'question', 'decision', 'touch_draft', 'gate_request', 'system', 'outcome']),
  body: z.string().min(1),
  cites: z.array(UuidSchema).default([]),
  // Which exact phrase in `body` reflects each cited fact, so the UI can
  // highlight it inline without guessing from the fact's raw object_text
  // (which almost never survives paraphrasing into readable draft copy).
  // touch_draft only; other post kinds leave this empty.
  cite_quotes: z.array(z.object({ fact_id: UuidSchema, quote: z.string().min(1) })).default([]),
  // policy.drafter.arguments[].id — which argument this draft applied. Lets
  // "what did we argue, and how often" be a query rather than a read of 26
  // message bodies, and is what a withdrawal labels when one turns out wrong.
  argument_id: z.string().min(1).optional(),
  parent_post_id: UuidSchema.optional(),
  thread_root_id: UuidSchema.optional(),
  // How much this claim's facts moved the account's score (score_after -
  // score_before), computed by the caller at rescore time. Only set on
  // enricher-sourced claims that triggered a rescore.
  score_delta: z.number().optional(),
});

export const QuerySchema = z.object({
  nl: z.string().min(1),
  perspective: z.string().optional(),
  source_id: z.string().optional(),
});

export const CiteSchema = z.object({
  id: UuidSchema,
});

export const RequestGateSchema = z.object({
  channel_post_id: UuidSchema.optional(),
  policy: z.string().min(1),
  condition: z.record(z.unknown()).default({}),
});

export const DecideGateSchema = z.object({
  gate_id: UuidSchema,
  decision: z.enum(['approve', 'reject', 'modify']),
  resolution: z.record(z.unknown()).optional(),
});

// ─── Read-side tools ──────────────────────────────────────────────────────────
// These don't write events; they project current state for agent consumption.
// Returns are token-efficient summaries, not raw row dumps.

export const ListEntitiesSchema = z.object({
  status: z.enum(['draft_ready', 'gated', 'active', 'stale', 'no_signals']).optional(),
  signal_source: z.string().optional(),
  limit: z.number().int().min(1).max(500).default(100),
  since_hours: z.number().int().positive().optional(),
  sort_by: z.enum(['activity', 'icp_fit']).default('activity'),
});

export const GetEntitySchema = z.object({
  entity_id: UuidSchema,
});

export const OutreachStateSchema = z.object({
  entity_id: UuidSchema,
});

export const HealthCheckSchema = z.object({});

export const FindSimilarEntitiesSchema = z.object({
  entity_id: UuidSchema,
  top_k: z.number().int().min(1).max(50).default(8),
  perspective: z.string().optional(),
});

export const LookupEntitySchema = z.object({
  name: z.string().min(1),
  fuzzy: z.boolean().default(true),
  limit: z.number().int().min(1).max(20).default(5),
});

export const PastOutcomesSchema = z.object({
  entity_id: UuidSchema.optional(),
  signal_type: z.string().optional(),
  semantic_neighbors: z.boolean().default(true),
  limit: z.number().int().min(1).max(20).default(5),
  since_days: z.number().int().min(1).max(365).default(30),
});

export const FindContactsSchema = z.object({
  domain: z.string().min(1),
  limit: z.number().int().min(1).max(20).default(5),
  role_filter: z.string().optional(),
});

export const LinkContactToAccountSchema = z.object({
  account_entity_id: UuidSchema,
  name: z.string().min(1),
  email: z.string().email(),
  role: z.string().optional(),
});

export const ScoreEntitySchema = z.object({
  entity_id: UuidSchema,
  assert: z.boolean().default(true),  // assert as fact, or just compute
});

export const TokenSummarySchema = z.object({
  since_hours: z.number().int().min(1).max(720).default(24),
});

// Update a source's mutable fields. The L2 curator uses this to deactivate
// dead sources or rewrite their config. Recorded as an event so the prior
// state in the payload is what the undo path reads back.
export const UpdateSourceSchema = z.object({
  source_id: UuidSchema,
  active: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
  // Caller must include prior_state so the resulting event row is
  // self-sufficient for undo. The tool doesn't second-guess what was
  // before — that's the caller's responsibility because reading prior
  // state and applying the mutation aren't atomic in PostgREST.
  prior_state: z.record(z.unknown()),
  reasoning: z.string().min(1),
});

// Set the other names an account's coverage is written under. This is the only
// supported write path for attributes.aliases — before it existed the field
// could only be filled by editing the database by hand, which no customer can
// do. Replaces the list outright rather than appending so an agent can also
// REMOVE an alias that turned out to admit junk; pass the current value in
// prior_state so the event row alone is enough to undo it.
export const SetEntityAliasesSchema = z.object({
  entity_id: UuidSchema,
  aliases: z.array(z.string().min(1)).max(10),
  prior_state: z.record(z.unknown()),
  reasoning: z.string().min(1),
});

// Read what the workspace is configured to do. No section = everything on the
// allowlist, which is the answer to "what is my agent actually set up to do" —
// a question nothing could answer before, because the research questions in
// particular have no screen anywhere in the app.
export const ReadWorkspaceConfigSchema = z.object({
  section: z.string().optional(),
});

// Change one part of it. `value` is the finished value, not an instruction:
// the caller is already a model holding the conversation, so turning "widen
// that question" into a concrete value is its job, and doing it again in the
// tool would mean a second prompt and a second bill for the same sentence.
//
// No prior_state argument, unlike update_source and set_entity_aliases. Those
// take it because reading and writing are not atomic and the caller has already
// read. Here the tool does its own read a line before the write, so asking the
// caller for it would only invite a wrong one.
export const UpdateWorkspaceConfigSchema = z.object({
  section: z.string().min(1),
  value: z.unknown(),
  reasoning: z.string().min(1),
});

export const TOOL_SCHEMAS = {
  create_workspace: CreateWorkspaceSchema,
  set_workspace_policy: SetWorkspacePolicySchema,
  create_account: CreateAccountSchema,
  create_contact: CreateContactSchema,
  create_entity: CreateEntitySchema,
  assert_fact: AssertFactSchema,
  supersede_fact: SupersedeFactSchema,
  create_signal: CreateSignalSchema,
  create_subscription: CreateSubscriptionSchema,
  post_to_channel: PostToChannelSchema,
  query: QuerySchema,
  cite: CiteSchema,
  request_gate: RequestGateSchema,
  decide_gate: DecideGateSchema,
  list_entities: ListEntitiesSchema,
  get_entity: GetEntitySchema,
  outreach_state: OutreachStateSchema,
  health_check: HealthCheckSchema,
  find_similar_entities: FindSimilarEntitiesSchema,
  lookup_entity: LookupEntitySchema,
  past_outcomes: PastOutcomesSchema,
  find_contacts: FindContactsSchema,
  link_contact_to_account: LinkContactToAccountSchema,
  score_entity: ScoreEntitySchema,
  token_summary: TokenSummarySchema,
  update_source: UpdateSourceSchema,
  set_entity_aliases: SetEntityAliasesSchema,
  read_workspace_config: ReadWorkspaceConfigSchema,
  update_workspace_config: UpdateWorkspaceConfigSchema,
  add_note: AddNoteSchema,
  list_approvals: ListApprovalsSchema,
  pull_contacts: PullContactsSchema,
  research_account: ResearchAccountSchema,
} as const;

export type ToolName = keyof typeof TOOL_SCHEMAS;
