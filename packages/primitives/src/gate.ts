import type { SupabaseClient } from '@supabase/supabase-js';
import { act } from './act.ts';
import { GateArgsSchema, type Actor, type GateArgs } from './types.ts';

/**
 * Open a gate. The only path that interrupts a human. A gate insert fires a `gate.created`
 * event into Inngest which dispatches notifications according to workspace policy.
 */
export async function gate(
  supabase: SupabaseClient,
  actor: Actor,
  args: GateArgs,
): Promise<{ gate_id: string; event_id: string }> {
  const v = GateArgsSchema.parse(args);
  const { event_id, target_id } = await act(supabase, actor, {
    tool: 'request_gate',
    args: {
      channel_post_id: v.channel_post_id,
      policy: v.policy,
      condition: v.condition,
    },
  });
  return { gate_id: target_id, event_id };
}

export async function decideGate(
  supabase: SupabaseClient,
  actor: Actor,
  gate_id: string,
  decision: 'approve' | 'reject' | 'modify',
): Promise<{ event_id: string }> {
  const { event_id } = await act(supabase, actor, {
    tool: 'decide_gate',
    args: { decision },
    target_id: gate_id,
  });
  return { event_id };
}
