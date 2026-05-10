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

export const AssertFactSchema = z.object({
  subject_entity: UuidSchema,
  predicate: z.string().min(1),
  object_text: z.string().optional(),
  object_entity: UuidSchema.optional(),
  confidence: z.number().min(0).max(1).default(1.0),
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
  parent_post_id: UuidSchema.optional(),
  thread_root_id: UuidSchema.optional(),
});

export const QuerySchema = z.object({
  nl: z.string().min(1),
  perspective: z.string().optional(),
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
});

// ─── Read-side tools ──────────────────────────────────────────────────────────
// These don't write events; they project current state for agent consumption.
// Returns are token-efficient summaries, not raw row dumps.

export const ListEntitiesSchema = z.object({
  status: z.enum(['draft_ready', 'gated', 'active', 'stale', 'no_signals']).optional(),
  signal_source: z.string().optional(),
  limit: z.number().int().min(1).max(500).default(100),
  since_hours: z.number().int().positive().optional(),
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

export const TOOL_SCHEMAS = {
  create_workspace: CreateWorkspaceSchema,
  set_workspace_policy: SetWorkspacePolicySchema,
  create_account: CreateAccountSchema,
  create_contact: CreateContactSchema,
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
} as const;

export type ToolName = keyof typeof TOOL_SCHEMAS;
