import { z } from 'zod';

export const UuidSchema = z.string().uuid();

export const ActorKindSchema = z.enum(['agent', 'user', 'system']);
export type ActorKind = z.infer<typeof ActorKindSchema>;

export const TargetKindSchema = z.enum([
  'entity', 'fact', 'signal', 'subscription', 'channel', 'channel_post',
  'touch', 'gate', 'workspace', 'conversation', 'outcome',
]);
export type TargetKind = z.infer<typeof TargetKindSchema>;

export interface Cite {
  fact_id: string;
  source_event_id: string;
  prompt_hash?: string | null;
}

export interface Projection<T = unknown> {
  value: T;
  cites: Cite[];
  computed_at: string;
}

export interface EventRow {
  id: string;
  workspace_id: string;
  actor_kind: ActorKind;
  actor_id: string;
  action: string;
  target_kind: TargetKind;
  target_id: string | null;
  payload: Record<string, unknown>;
  prompt_hash: string | null;
  parent_event_id: string | null;
  created_at: string;
}

export interface FactRow {
  id: string;
  workspace_id: string;
  subject_entity: string;
  predicate: string;
  object_text: string | null;
  object_entity: string | null;
  source_event_id: string;
  confidence: number;
  observed_at: string;
  supersedes: string | null;
  content_hash: string;
}

export const ActorSchema = z.object({
  workspace_id: UuidSchema,
  actor_kind: ActorKindSchema,
  actor_id: z.string().min(1),
});
export type Actor = z.infer<typeof ActorSchema>;

export const FilterSchema = z.object({
  semantic: z.string().optional(),
  structured: z.record(z.unknown()).optional(),
  threshold: z.number().min(0).max(1).optional(),
  action: z.string().default('agent.run'),
});
export type Filter = z.infer<typeof FilterSchema>;

export const SubscribeArgsSchema = z.object({
  owner_kind: z.enum(['agent', 'user']),
  owner_id: z.string().min(1),
  name: z.string().min(1),
  filter: FilterSchema,
});
export type SubscribeArgs = z.infer<typeof SubscribeArgsSchema>;

export const ActArgsSchema = z.object({
  tool: z.string().min(1),
  args: z.record(z.unknown()),
  prompt_hash: z.string().optional(),
  parent_event_id: z.string().optional(),
});
export type ActArgs = z.infer<typeof ActArgsSchema>;

export const GateArgsSchema = z.object({
  channel_post_id: UuidSchema.optional(),
  policy: z.string().min(1),
  condition: z.record(z.unknown()).default({}),
});
export type GateArgs = z.infer<typeof GateArgsSchema>;

export const QueryArgsSchema = z.object({
  nl: z.string().min(1),
  perspective: z.string().optional(),
  asker: z.string().optional(),
});
export type QueryArgs = z.infer<typeof QueryArgsSchema>;

export const CiteArgsSchema = z.object({
  id: UuidSchema,
});
export type CiteArgs = z.infer<typeof CiteArgsSchema>;
