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
const EXPLORIUM_API = 'https://api.explorium.ai/v1';

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

// Titles that signal a decision-maker, highest first. Used to rank Explorium
// prospects client-side so we don't have to guess Explorium's job_level enum
// (a bad enum value 400s the whole fetch). Generic seller-relevant seniority —
// no vertical assumption.
const DECISION_MAKER_TITLES = [
  'founder', 'co-founder', 'cofounder', 'ceo', 'chief executive', 'owner',
  'president', 'cto', 'coo', 'chief', 'vp', 'vice president', 'head of', 'director',
];

function titleRank(title: string): number {
  const t = title.toLowerCase();
  const idx = DECISION_MAKER_TITLES.findIndex((kw) => t.includes(kw));
  return idx === -1 ? DECISION_MAKER_TITLES.length : idx;
}

/**
 * Contact discovery via Explorium (a.k.a. the "Vibe Prospecting" provider).
 * Better coverage than Hunter on young/small startups. Pure HTTP wrapper, no DB
 * writes — same `{ name, email, role }` projection the runner expects.
 *
 * Keyed per-workspace: the caller resolves EXPLORIUM_API_KEY (policy.env → env)
 * and passes it in, so this stays callable from any tenant without reading
 * process.env directly.
 *
 * Three calls: match business by domain → fetch prospects for that business_id →
 * enrich each prospect's contact info for the email. Prospects are ranked by
 * decision-maker title client-side; only the top `limit` are enriched (each
 * enrich costs a credit), so cost scales with `limit`, not the company headcount.
 */
export async function findContactsExplorium(args: {
  domain: string;
  apiKey: string;
  limit: number;
  role_filter?: string;
}): Promise<Array<{ name: string; email: string; role: string }>> {
  const headers = { 'api_key': args.apiKey, 'Content-Type': 'application/json' };

  // 1) Match the business by domain → business_id
  const matchRes = await fetch(`${EXPLORIUM_API}/businesses/match`, {
    method: 'POST', headers,
    body: JSON.stringify({ businesses_to_match: [{ domain: args.domain }] }),
  });
  if (!matchRes.ok) throw new Error(`Explorium match ${matchRes.status}: ${(await matchRes.text()).slice(0, 300)}`);
  const matchJson = (await matchRes.json()) as { matched_businesses?: Array<{ business_id?: string | null }> };
  const businessId = matchJson.matched_businesses?.[0]?.business_id;
  if (!businessId) return []; // no match on this domain — nothing to pull

  // 2) Fetch prospects for that business. Business filter only; rank roles below.
  const prospectsRes = await fetch(`${EXPLORIUM_API}/prospects`, {
    method: 'POST', headers,
    body: JSON.stringify({
      mode: 'full', page: 1, page_size: Math.min(Math.max(args.limit * 3, 10), 50),
      filters: { business_id: { type: 'includes', values: [businessId] } },
    }),
  });
  if (!prospectsRes.ok) throw new Error(`Explorium prospects ${prospectsRes.status}: ${(await prospectsRes.text()).slice(0, 300)}`);
  const prospectsJson = (await prospectsRes.json()) as {
    data?: Array<{ prospect_id?: string; full_name?: string; job_title?: string }>;
  };
  let prospects = (prospectsJson.data ?? []).filter((p) => p.prospect_id);

  // Rank by decision-maker title (role_filter biases toward matching titles).
  if (args.role_filter) {
    const needle = args.role_filter.toLowerCase();
    const hits = prospects.filter((p) => (p.job_title ?? '').toLowerCase().includes(needle));
    if (hits.length) prospects = hits;
  }
  prospects.sort((a, b) => titleRank(a.job_title ?? '') - titleRank(b.job_title ?? ''));
  const top = prospects.slice(0, args.limit);

  // 3) Enrich each top prospect for an email. One credit each; bounded by limit.
  const out: Array<{ name: string; email: string; role: string }> = [];
  for (const p of top) {
    try {
      const enrichRes = await fetch(`${EXPLORIUM_API}/prospects/contacts_information/enrich`, {
        method: 'POST', headers,
        body: JSON.stringify({ prospect_id: p.prospect_id }),
      });
      if (!enrichRes.ok) continue; // skip one bad prospect; keep the rest
      const enrichJson = (await enrichRes.json()) as {
        data?: { emails?: Array<string | { email?: string; address?: string; value?: string }> };
      };
      const rawEmail = (enrichJson.data?.emails ?? [])[0];
      const email = (typeof rawEmail === 'string' ? rawEmail : (rawEmail?.email ?? rawEmail?.address ?? rawEmail?.value ?? '')).toLowerCase().trim();
      if (!email || !email.includes('@')) continue;
      out.push({ name: (p.full_name ?? '').trim() || email.split('@')[0] || email, email, role: (p.job_title ?? '').trim() });
    } catch {
      // network hiccup on one prospect — keep the others
    }
  }
  return out;
}

/**
 * Names-first contact link. Unlike linkContactToAccount, this does NOT require
 * an email — it stores name + role + linkedin_url + an external prospect_id, so
 * contacts can be pulled cheaply (discovery) and the email bought later.
 *
 * Idempotent on the prospect_id fact (mirrors the email dedupe above). When no
 * prospect_id is given, falls back to dedupe on (works_at account, lowercased
 * name) so a missing id can't spawn duplicates.
 */
export async function linkContactByProspectId(
  supabase: SupabaseClient,
  actor: { workspace_id: string; actor_kind: 'agent' | 'user' | 'system'; actor_id: string },
  args: { account_entity_id: string; name: string; role?: string; linkedin_url?: string; prospect_id?: string },
): Promise<LinkResult> {
  const name = args.name.trim();
  if (!name) throw new Error('name is required');
  const prospectId = args.prospect_id?.trim();

  // Dedupe 1: existing contact by prospect_id fact
  if (prospectId) {
    const existing = await supabase.from('facts')
      .select('subject_entity')
      .eq('workspace_id', actor.workspace_id)
      .eq('predicate', 'prospect_id')
      .eq('object_text', prospectId)
      .is('supersedes', null)
      .limit(1).maybeSingle();
    if (existing.data?.subject_entity) {
      return { contact_entity_id: existing.data.subject_entity as string, created: false };
    }
  } else {
    // Dedupe 2 (no id): a contact already linked to this account with the same name
    const linked = await supabase.from('facts')
      .select('subject_entity')
      .eq('workspace_id', actor.workspace_id)
      .eq('predicate', 'works_at')
      .eq('object_entity', args.account_entity_id)
      .is('supersedes', null);
    const ids = (linked.data ?? []).map((r) => r.subject_entity as string);
    if (ids.length) {
      const ents = await supabase.from('entities').select('id, name').in('id', ids);
      const match = (ents.data ?? []).find((e) => (e.name as string).trim().toLowerCase() === name.toLowerCase());
      if (match) return { contact_entity_id: match.id as string, created: false };
    }
  }

  // Create contact entity (no email; prospect_id kept in attributes for trace)
  const created = await act(supabase, actor, {
    tool: 'create_contact',
    args: { name, account_entity_id: args.account_entity_id, attributes: prospectId ? { prospect_id: prospectId } : {} },
  });
  const contact_entity_id = created.target_id;

  await act(supabase, actor, {
    tool: 'assert_fact',
    args: { subject_entity: contact_entity_id, predicate: 'works_at', object_entity: args.account_entity_id, confidence: 0.95 },
  });
  if (prospectId) {
    await act(supabase, actor, {
      tool: 'assert_fact',
      args: { subject_entity: contact_entity_id, predicate: 'prospect_id', object_text: prospectId, confidence: 0.99 },
    });
  }
  if (args.role?.trim()) {
    await act(supabase, actor, {
      tool: 'assert_fact',
      args: { subject_entity: contact_entity_id, predicate: 'role', object_text: args.role.trim(), confidence: 0.9 },
    });
  }
  if (args.linkedin_url?.trim()) {
    await act(supabase, actor, {
      tool: 'assert_fact',
      args: { subject_entity: contact_entity_id, predicate: 'linkedin_url', object_text: args.linkedin_url.trim(), confidence: 0.9 },
    });
  }

  return { contact_entity_id, created: true };
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
