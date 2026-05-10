/**
 * Contact discovery via Hunter.io. Free tier 25/mo, Starter $34/mo for 500 reqs.
 *
 * Two layers:
 *   findContacts — pure HTTP wrapper, no DB writes. Token-efficient projection.
 *   linkContactToAccount — creates a contact entity + works_at/email/role facts,
 *                          idempotent on email.
 *
 * The agent calls these via MCP. Auto-link happens in the enricher dispatch
 * path in agent_logic.ts when an entity has a domain but no linked contacts.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { act } from '@agent-crm/primitives';

const HUNTER_API = 'https://api.hunter.io/v2/domain-search';

export interface Contact {
  name: string;
  email: string;
  role: string;
  seniority: string | null;
  source_confidence: number;
}

export async function findContacts(args: {
  domain: string;
  limit: number;
  role_filter?: string;
}): Promise<Contact[]> {
  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey) throw new Error('HUNTER_API_KEY not set');

  const url = new URL(HUNTER_API);
  url.searchParams.set('domain', args.domain);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('limit', String(Math.min(args.limit * 2, 25)));  // overshoot, filter after
  if (args.role_filter) url.searchParams.set('seniority', mapRoleFilterToSeniority(args.role_filter));

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Hunter ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as {
    data?: {
      emails?: Array<{
        first_name?: string; last_name?: string; value?: string;
        position?: string; seniority?: string; confidence?: number;
      }>;
    };
  };

  const emails = json.data?.emails ?? [];
  const contacts: Contact[] = emails
    .filter((e) => !!e.value)
    .map((e) => {
      const fullName = [e.first_name, e.last_name].filter(Boolean).join(' ').trim();
      const email = (e.value ?? '').toLowerCase();
      const fallbackName = email.split('@')[0] || 'unknown';
      return {
        name: fullName || fallbackName,
        email,
        role: (e.position ?? '').trim(),
        seniority: e.seniority ?? null,
        source_confidence: typeof e.confidence === 'number' ? e.confidence / 100 : 0,
      };
    })
    .filter((c) => c.email && c.email.includes('@'))
    .sort((a, b) => b.source_confidence - a.source_confidence);

  // Apply role_filter as a post-filter too (Hunter's seniority param is coarse)
  let filtered = contacts;
  if (args.role_filter) {
    const needle = args.role_filter.toLowerCase();
    const matches = contacts.filter((c) => c.role.toLowerCase().includes(needle));
    if (matches.length) filtered = matches;
  }
  return filtered.slice(0, args.limit);
}

function mapRoleFilterToSeniority(filter: string): string {
  const f = filter.toLowerCase();
  if (/(founder|ceo|cto|cmo|cfo|coo|chief|vp|vice president)/.test(f)) return 'executive';
  if (/(director|head of|lead|manager)/.test(f)) return 'senior';
  return 'junior';  // Hunter's enum: junior | senior | executive
}

export interface LinkResult {
  contact_entity_id: string;
  created: boolean;  // true = new, false = existed
}

/**
 * Idempotent. If a contact entity in the workspace already has a fact
 * (predicate=email, object_text=<email>), reuse it. Otherwise create.
 */
export async function linkContactToAccount(
  supabase: SupabaseClient,
  actor: { workspace_id: string; actor_kind: 'agent' | 'user' | 'system'; actor_id: string },
  args: { account_entity_id: string; name: string; email: string; role?: string },
): Promise<LinkResult> {
  const email = args.email.trim().toLowerCase();
  if (!email || !email.includes('@')) throw new Error(`invalid email: ${args.email}`);

  // Look up existing contact by email fact
  const existing = await supabase.from('facts')
    .select('subject_entity')
    .eq('workspace_id', actor.workspace_id)
    .eq('predicate', 'email')
    .eq('object_text', email)
    .is('supersedes', null)
    .limit(1).maybeSingle();
  if (existing.data?.subject_entity) {
    return { contact_entity_id: existing.data.subject_entity as string, created: false };
  }

  // Create contact entity
  const created = await act(supabase, actor, {
    tool: 'create_contact',
    args: { name: args.name, account_entity_id: args.account_entity_id, attributes: { email } },
  });
  const contact_entity_id = created.target_id;

  // Assert email + works_at + (optional) role facts
  await act(supabase, actor, {
    tool: 'assert_fact',
    args: { subject_entity: contact_entity_id, predicate: 'email', object_text: email, confidence: 0.95 },
  });
  await act(supabase, actor, {
    tool: 'assert_fact',
    args: { subject_entity: contact_entity_id, predicate: 'works_at', object_entity: args.account_entity_id, confidence: 0.95 },
  });
  if (args.role) {
    await act(supabase, actor, {
      tool: 'assert_fact',
      args: { subject_entity: contact_entity_id, predicate: 'role', object_text: args.role, confidence: 0.9 },
    });
  }

  return { contact_entity_id, created: true };
}
