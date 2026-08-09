import { createServerClient } from '@agent-crm/db';
import { inngest } from '../client.ts';
import { runAgent } from './agent_logic.ts';

/**
 * subscription.matched -> agent.run (if owner is an agent).
 */
export const onSubscriptionMatched = inngest.createFunction(
  { id: 'on-subscription-matched', concurrency: { limit: 5, key: 'event.data.workspace_id' } },
  { event: 'subscription.matched' },
  async ({ event, step }) => {
    if (event.data.owner_kind !== 'agent') {
      return { skipped: true, reason: 'human-owned subscription' };
    }

    // Resolve the entity this match is about so the agent.run can be keyed to it
    // for per-entity serialization. One indexed read at the single choke point
    // before dispatch (cheaper than threading entity_id through the match RPC).
    const entity_id = await step.run('resolve-entity', async () => {
      const supabase = createServerClient();
      if (event.data.signal_id) {
        const { data } = await supabase.from('signals').select('entity_id').eq('id', event.data.signal_id).maybeSingle();
        return (data?.entity_id as string | undefined) ?? null;
      }
      if (event.data.fact_id) {
        const { data } = await supabase.from('facts').select('subject_entity').eq('id', event.data.fact_id).maybeSingle();
        return (data?.subject_entity as string | undefined) ?? null;
      }
      return null;
    });

    await step.sendEvent('dispatch-agent', {
      name: 'agent.run',
      // Idempotency: the same (signal|fact, agent) pair must enrich once even if
      // both the organic match path AND research's direct dispatch fire for it.
      // Inngest drops a duplicate event id, so this collapses the double-dispatch
      // that was enriching one signal twice with identical facts + posts.
      ...(event.data.signal_id || event.data.fact_id
        ? { id: `agentrun:${event.data.signal_id ?? event.data.fact_id}:${event.data.owner_id}` }
        : {}),
      data: {
        workspace_id: event.data.workspace_id,
        agent: event.data.owner_id,
        trigger_event: 'subscription.matched',
        subscription_id: event.data.subscription_id,
        signal_id: event.data.signal_id,
        fact_id: event.data.fact_id,
        ...(entity_id ? { entity_id } : {}),
      },
    });

    return { dispatched: event.data.owner_id, entity_id };
  },
);

/**
 * agent.run: load context, call LLM, dispatch tool call. Each phase is one durable
 * step so failures retry independently.
 */
export const agentRun = inngest.createFunction(
  {
    id: 'agent-run',
    // Two constraints: cap total per-workspace throughput at 5, AND serialize
    // runs about the SAME entity (limit 1). The per-entity key is what makes the
    // enricher's coalesce + cooldown guards reliable — before this, a burst of
    // signals about one account ran concurrently and every guard read stale state,
    // so each run re-enriched and re-posted. Runs with no entity_id (legacy/manual
    // dispatches) share one bucket; production always sets it.
    concurrency: [
      { scope: 'fn', key: 'event.data.workspace_id', limit: 5 },
      { scope: 'fn', key: 'event.data.entity_id', limit: 1 },
    ],
  },
  { event: 'agent.run' },
  async ({ event, step }) => {
    const result = await step.run('run-agent', async () => {
      const supabase = createServerClient();
      return runAgent(supabase, {
        workspace_id: event.data.workspace_id,
        agent: event.data.agent,
        subscription_id: event.data.subscription_id,
        signal_id: event.data.signal_id,
        fact_id: event.data.fact_id,
        parent_event_id: event.data.parent_event_id,
      });
    });
    return result;
  },
);
