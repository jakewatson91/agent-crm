import { createServerClient } from '@agent-crm/db';
import { inngest } from '../client.js';
import { runAgent } from './agent_logic.js';

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

    await step.sendEvent('dispatch-agent', {
      name: 'agent.run',
      data: {
        workspace_id: event.data.workspace_id,
        agent: event.data.owner_id,
        trigger_event: 'subscription.matched',
        subscription_id: event.data.subscription_id,
        signal_id: event.data.signal_id,
      },
    });

    return { dispatched: event.data.owner_id };
  },
);

/**
 * agent.run: load context, call LLM, dispatch tool call. Each phase is one durable
 * step so failures retry independently.
 */
export const agentRun = inngest.createFunction(
  { id: 'agent-run', concurrency: { limit: 5, key: 'event.data.workspace_id' } },
  { event: 'agent.run' },
  async ({ event, step }) => {
    const result = await step.run('run-agent', async () => {
      const supabase = createServerClient();
      return runAgent(supabase, {
        workspace_id: event.data.workspace_id,
        agent: event.data.agent,
        subscription_id: event.data.subscription_id,
        signal_id: event.data.signal_id,
        parent_event_id: event.data.parent_event_id,
      });
    });
    return result;
  },
);
