import type { SupabaseClient } from '@supabase/supabase-js';
import { act } from './act.ts';
import { embed, vectorLiteral } from './embed.ts';
import { SubscribeArgsSchema, type Actor, type SubscribeArgs } from './types.ts';

/**
 * Save a long-running filter rule. Matching events fire `action_on_match`
 * (default 'agent.run') via Inngest when their structured tags AND semantic similarity
 * to the rule clear the threshold.
 */
export async function subscribe(
  supabase: SupabaseClient,
  actor: Actor,
  args: SubscribeArgs,
): Promise<{ subscription_id: string; event_id: string }> {
  const v = SubscribeArgsSchema.parse(args);
  const semanticText = v.filter.semantic ?? v.name;
  const embedding = await embed(semanticText);

  const { event_id, target_id } = await act(supabase, actor, {
    tool: 'create_subscription',
    args: {
      owner_kind: v.owner_kind,
      owner_id: v.owner_id,
      name: v.name,
      semantic_query: semanticText,
      semantic_embedding: vectorLiteral(embedding),
      structured_filter: v.filter.structured ?? {},
      threshold: v.filter.threshold ?? 0.75,
      action_on_match: v.filter.action,
      active: true,
    },
  });

  return { subscription_id: target_id, event_id };
}
