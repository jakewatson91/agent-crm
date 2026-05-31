import type { SupabaseClient } from '@supabase/supabase-js';
import { ActArgsSchema, ActorSchema, type Actor, type EventRow } from './types.ts';

const TARGET_KIND_BY_TOOL: Record<string, string> = {
  create_workspace: 'workspace',
  set_workspace_policy: 'workspace',
  create_account: 'entity',
  create_contact: 'entity',
  create_entity: 'entity',
  assert_fact: 'fact',
  supersede_fact: 'fact',
  create_signal: 'signal',
  create_subscription: 'subscription',
  update_source: 'source',
  post_to_channel: 'channel_post',
  request_gate: 'gate',
  decide_gate: 'gate',
  record_touch: 'touch',
  record_outcome: 'outcome',
};

export interface ActResult {
  event_id: string;
  target_id: string;
}

/**
 * `act` is the only sanctioned write path. Every call produces exactly one row in events
 * and (for known actions) upserts the corresponding projection row(s) atomically.
 */
export async function act(
  supabase: SupabaseClient,
  actor: Actor,
  args: { tool: string; args: Record<string, unknown>; prompt_hash?: string; parent_event_id?: string; target_id?: string },
): Promise<ActResult> {
  const validatedActor = ActorSchema.parse(actor);
  const validated = ActArgsSchema.parse({
    tool: args.tool,
    args: args.args,
    prompt_hash: args.prompt_hash,
    parent_event_id: args.parent_event_id,
  });

  const targetKind = TARGET_KIND_BY_TOOL[validated.tool] ?? 'entity';

  const { data, error } = await supabase.rpc('record_event', {
    p_workspace_id: validatedActor.workspace_id,
    p_actor_kind: validatedActor.actor_kind,
    p_actor_id: validatedActor.actor_id,
    p_action: validated.tool,
    p_target_kind: targetKind,
    p_target_id: args.target_id ?? null,
    p_payload: validated.args,
    p_prompt_hash: validated.prompt_hash ?? null,
    p_parent_event_id: validated.parent_event_id ?? null,
  });

  if (error) throw new Error(`act(${validated.tool}) failed: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error(`act(${validated.tool}) returned no row`);
  return { event_id: String(row.event_id), target_id: String(row.target_id) };
}

export async function getEvent(supabase: SupabaseClient, event_id: string): Promise<EventRow | null> {
  const { data, error } = await supabase.from('events').select('*').eq('id', event_id).maybeSingle();
  if (error) throw error;
  return data as EventRow | null;
}
