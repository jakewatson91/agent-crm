import { createServerClient } from '@agent-crm/db';
import { inngest } from '../client.js';

/**
 * On signal.created, find every active subscription whose structured filter contains the
 * signal's tags AND whose semantic embedding is within threshold cosine distance.
 *
 * For each match, fan out a `subscription.matched` event so downstream agent runs
 * (or human-owned channel posts) can react independently.
 */
export const matchSignal = inngest.createFunction(
  {
    id: 'match-signal',
    concurrency: { limit: 50, key: 'event.data.workspace_id' },
  },
  { event: 'signal.created' },
  async ({ event, step }) => {
    const { signal_id } = event.data;

    const matches = await step.run('match', async () => {
      const supabase = createServerClient();
      const { data, error } = await supabase.rpc('match_signal_to_subscriptions', { p_signal_id: signal_id });
      if (error) throw new Error(`match_signal_to_subscriptions failed: ${error.message}`);
      return data as Array<{
        subscription_id: string;
        owner_kind: 'agent' | 'user';
        owner_id: string;
        action_on_match: string;
        similarity: number;
      }>;
    });

    if (matches.length === 0) return { matched: 0 };

    await step.sendEvent('fan-out-matches', matches.map((m) => ({
      name: 'subscription.matched' as const,
      data: {
        subscription_id: m.subscription_id,
        signal_id,
        workspace_id: event.data.workspace_id,
        owner_kind: m.owner_kind,
        owner_id: m.owner_id,
        action_on_match: m.action_on_match,
        similarity: m.similarity,
      },
    })));

    return { matched: matches.length };
  },
);
