/**
 * Contacts-runner. Triggered by action_selector (via agent_logic) when an
 * account fits the ICP but lacks a strong enough contact to email — the
 * two-tier `enrich_contacts` action. Pulls decision-makers for the account's
 * domain through the workspace's configured contact provider, links them, and
 * scores each so the next decision cycle has a real person to draft to.
 *
 * Provider is `policy.enrichment.contact_provider`:
 *   - 'hunter'    — works today, keyed by HUNTER_API_KEY (domain search returns
 *                   name + email + role in one call).
 *   - 'explorium' — preferred for young startups, but needs the workspace's
 *                   Explorium API key + REST client (pending). No-ops with a
 *                   clear audit fact until wired.
 *   - 'none'/unset — no-op (the action still recorded the decision upstream).
 *
 * Concurrency-limited per workspace. Writes a `contacts_completed` audit fact
 * either way so the attempt is on the record.
 */
import { createServerClient } from '@agent-crm/db';
import { findContacts, findContactsExplorium, linkContactToAccount, scoreAndAssert, getPolicy, resolveEnvVar } from '@agent-crm/tools';
import { inngest } from '../client.js';

const MAX_CONTACTS = 5;

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
      const actor = { workspace_id, actor_kind: 'agent' as const, actor_id: 'contacts_runner' };

      async function audit(text: string): Promise<void> {
        await supabase.from('facts').insert({
          workspace_id, subject_entity: entity_id,
          predicate: 'contacts_completed', object_text: text.slice(0, 200), confidence: 1.0,
          content_hash: `contacts_completed:${entity_id}:${Date.now()}`, source_event_id: 0,
        });
      }

      const ent = await supabase.from('entities').select('attributes').eq('id', entity_id).maybeSingle();
      const domain = (ent.data?.attributes as { domain?: string } | null)?.domain;
      if (!domain) { await audit('no domain on account'); return { ok: false, reason: 'no domain' }; }

      const policy = await getPolicy(supabase, workspace_id);
      const provider = policy.enrichment?.contact_provider ?? 'none';

      // Resolve provider -> a list of {name, email, role}. Only Hunter is wired.
      let pulled: Array<{ name: string; email: string; role: string }> = [];
      if (provider === 'hunter') {
        if (!process.env.HUNTER_API_KEY) { await audit('hunter selected but HUNTER_API_KEY not set'); return { ok: false, reason: 'HUNTER_API_KEY not set' }; }
        try {
          const cs = await findContacts({ domain, limit: MAX_CONTACTS, role_filter: 'founder' });
          pulled = cs.filter((c) => c.email).map((c) => ({ name: c.name, email: c.email, role: c.role }));
        } catch (e) {
          await audit(`hunter error: ${e instanceof Error ? e.message : String(e)}`);
          return { ok: false, reason: 'hunter error' };
        }
      } else if (provider === 'explorium') {
        // Per-workspace key: policy.env.EXPLORIUM_API_KEY → process.env fallback.
        const apiKey = resolveEnvVar(policy, 'EXPLORIUM_API_KEY');
        if (!apiKey) { await audit('explorium selected but EXPLORIUM_API_KEY not set'); return { ok: false, reason: 'EXPLORIUM_API_KEY not set' }; }
        try {
          pulled = await findContactsExplorium({ domain, apiKey, limit: MAX_CONTACTS, role_filter: 'founder' });
        } catch (e) {
          await audit(`explorium error: ${e instanceof Error ? e.message : String(e)}`);
          return { ok: false, reason: 'explorium error' };
        }
      } else {
        await audit('no contact_provider configured');
        return { ok: false, reason: 'no contact_provider' };
      }

      // Link + score each pulled contact. linkContactToAccount is idempotent on
      // email, so a re-run won't duplicate; we only score newly-created ones.
      let created = 0;
      for (const c of pulled) {
        try {
          const r = await linkContactToAccount(supabase, actor, {
            account_entity_id: entity_id, name: c.name, email: c.email, role: c.role,
          });
          if (r.created) { await scoreAndAssert(supabase, actor, r.contact_entity_id); created++; }
        } catch {
          // skip one bad contact; the rest still land
        }
      }

      await audit(`${created} new contact(s) via ${provider} (${pulled.length} found)`);
      return { ok: true, provider, found: pulled.length, created };
    });
  },
);
