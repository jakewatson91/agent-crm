import { createServerClient } from '@agent-crm/db';
import { inngest } from '../client.js';

/**
 * On fact.created, find every active subscription whose fact_filter matches
 * the new fact (predicate + numeric/text comparison via match_fact_to_subscriptions
 * RPC). For each match, fan out a `subscription.matched` event keyed by
 * fact_id (instead of signal_id). Downstream on-subscription-matched dispatches
 * agent.run the same way.
 *
 * Backward compatible: subscriptions without fact_filter never match here, so
 * the existing signal-triggered flow continues unchanged.
 */
export const matchFact = inngest.createFunction(
  {
    id: 'match-fact',
    concurrency: { limit: 5, key: 'event.data.workspace_id' },
  },
  { event: 'fact.created' },
  async ({ event, step }) => {
    const { fact_id } = event.data;

    const matches = await step.run('match', async () => {
      const supabase = createServerClient();
      const { data, error } = await supabase.rpc('match_fact_to_subscriptions', { p_fact_id: fact_id });
      if (error) throw new Error(`match_fact_to_subscriptions failed: ${error.message}`);
      return data as Array<{
        subscription_id: string;
        owner_kind: 'agent' | 'user';
        owner_id: string;
        action_on_match: string;
      }>;
    });

    if (matches.length === 0) return { matched: 0 };

    await step.sendEvent('fan-out-fact-matches', matches.map((m) => ({
      name: 'subscription.matched' as const,
      data: {
        subscription_id: m.subscription_id,
        fact_id,
        workspace_id: event.data.workspace_id,
        owner_kind: m.owner_kind,
        owner_id: m.owner_id,
        action_on_match: m.action_on_match,
      },
    })));

    return { matched: matches.length };
  },
);
