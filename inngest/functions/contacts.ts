/**
 * Contacts-runner. Triggered by action_selector (via agent_logic) when an
 * account fits the ICP but lacks a strong enough contact to email — the
 * two-tier `enrich_contacts` action. Delegates the actual pull + link + score
 * to `pullContactsForAccount` in @agent-crm/tools, which is the single source
 * of truth shared with the daily loop (so behavior can't drift between the
 * Inngest path and the loop path while Inngest is down).
 *
 * Provider order comes from the workspace policy:
 *   enrichment.contact_provider           — primary (hunter | explorium)
 *   enrichment.contact_provider_fallback  — tried only if the primary finds none
 *
 * Concurrency-limited per workspace. A `contacts_completed` audit fact is
 * written either way (inside pullContactsForAccount), so the attempt is on
 * the record.
 */
import { createServerClient } from '@agent-crm/db';
import { pullContactsForAccount } from '@agent-crm/tools';
import { inngest } from '../client.ts';

export const contactsRunner = inngest.createFunction(
  {
    id: 'contacts-runner',
    concurrency: { limit: 2, key: 'event.data.workspace_id' },
  },
  { event: 'contacts.requested' },
  async ({ event, step }) => {
    const { workspace_id, entity_id } = event.data;
    return await step.run('pull-and-score-contacts', async () => {
      const supabase = createServerClient();
      return await pullContactsForAccount(supabase, { workspace_id, entity_id });
    });
  },
);
