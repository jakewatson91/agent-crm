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
import { getPolicy, resolveEnvVar, type WorkspacePolicy } from './policy.ts';
import { scoreAndAssert } from './scoring.ts';
import { recordActivityMarker, ACTIVITY_MARKERS } from './activity_markers.ts';

const HUNTER_API = 'https://api.hunter.io/v2/domain-search';
const EXPLORIUM_API = 'https://api.explorium.ai/v1';

// Generic role / group / inbox local-parts — universal email conventions, not a
// vertical assumption (mirrors the free-provider list the ingest path already
// hardcodes). An address like info@, support@, or no-reply@ is a shared inbox,
// never a decision-maker, so we keep them out of the contact graph entirely.
const ROLE_INBOX_ALIASES = new Set([
  'info', 'support', 'hello', 'hi', 'hey', 'sales', 'admin', 'administrator',
  'contact', 'contactus', 'team', 'help', 'helpdesk', 'office', 'accounts',
  'accounting', 'billing', 'noreply', 'donotreply', 'mailer', 'mail', 'email',
  'postmaster', 'marketing', 'press', 'media', 'pr', 'jobs', 'careers',
  'recruiting', 'recruitment', 'hr', 'people', 'enquiries', 'inquiries',
  'enquiry', 'inquiry', 'general', 'feedback', 'newsletter', 'notifications',
  'notification', 'security', 'abuse', 'legal', 'privacy', 'webmaster',
  'service', 'services', 'orders', 'shop', 'store',
]);

/**
 * True when an email's local-part is a generic role / group / inbox alias
 * (info@, support@, no-reply@, ...) rather than a real person. Splits on the
 * first separator so info-sales@ and sales.team@ also match. No vertical
 * assumptions — these are standard email conventions.
 */
export function isRoleInboxEmail(email: string): boolean {
  const local = (email.split('@')[0] ?? '').toLowerCase().trim();
  if (!local) return true;
  const collapsed = local.replace(/[._\-+]/g, '');  // no-reply -> noreply, do-not-reply -> donotreply
  const base = local.replace(/[._\-+].*$/, '');       // info-sales -> info, sales.team -> sales
  return ROLE_INBOX_ALIASES.has(local) || ROLE_INBOX_ALIASES.has(collapsed) || ROLE_INBOX_ALIASES.has(base);
}

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
  /** Workspace-resolved key. Falls back to process.env for keyless dev scripts. */
  apiKey?: string;
}): Promise<Contact[]> {
  const apiKey = args.apiKey ?? process.env.HUNTER_API_KEY;
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
      // Require a real name from the provider. Don't fall back to the email
      // local-part — that fabricates junk "contacts" (info@ -> "info") for
      // shared inboxes that have no person behind them.
      const fullName = [e.first_name, e.last_name].filter(Boolean).join(' ').trim();
      const email = (e.value ?? '').toLowerCase();
      return {
        name: fullName,
        email,
        role: (e.position ?? '').trim(),
        seniority: e.seniority ?? null,
        source_confidence: typeof e.confidence === 'number' ? e.confidence / 100 : 0,
      };
    })
    .filter((c) => c.email && c.email.includes('@') && c.name && !isRoleInboxEmail(c.email))
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
      // Require a real name and skip shared inboxes — same quality bar as Hunter.
      const fullName = (p.full_name ?? '').trim();
      if (!fullName || isRoleInboxEmail(email)) continue;
      out.push({ name: fullName, email, role: (p.job_title ?? '').trim() });
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
  contact_entity_id: string | null;  // null when skipped (no entity created)
  created: boolean;                   // true = new, false = existed or skipped
  skipped?: 'role_inbox' | 'no_name'; // set when we refused to create garbage
}

/**
 * Idempotent. If a contact entity in the workspace already has a fact
 * (predicate=email, object_text=<email>), reuse it. Otherwise create.
 *
 * Garbage guard (single chokepoint for every contact-creating path — Hunter,
 * Explorium, CSV import): refuse to create a contact for a role/group inbox
 * (info@, support@, ...) or one with no real name. Returns a skipped result
 * instead of throwing so callers keep processing the rest of a batch.
 */
export async function linkContactToAccount(
  supabase: SupabaseClient,
  actor: { workspace_id: string; actor_kind: 'agent' | 'user' | 'system'; actor_id: string },
  args: { account_entity_id: string; name: string; email: string; role?: string },
): Promise<LinkResult> {
  const email = args.email.trim().toLowerCase();
  if (!email || !email.includes('@')) throw new Error(`invalid email: ${args.email}`);

  if (isRoleInboxEmail(email)) return { contact_entity_id: null, created: false, skipped: 'role_inbox' };
  if (!args.name.trim()) return { contact_entity_id: null, created: false, skipped: 'no_name' };

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

const MAX_CONTACTS_PER_ACCOUNT = 5;

export interface PullContactsResult {
  ok: boolean;           // false only on a provider error (so health can flag it)
  reason?: string;
  error_detail?: string; // raw provider error text(s), for credit/auth classification
  provider?: string;     // provider that produced contacts (or was attempted)
  found: number;
  created: number;
}

/** Ordered provider list: primary then fallback, de-duped, 'none'/unset dropped. */
function providerOrder(policy: WorkspacePolicy): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const p of [policy.enrichment?.contact_provider, policy.enrichment?.contact_provider_fallback]) {
    if (p && p !== 'none' && !seen.has(p)) { seen.add(p); order.push(p); }
  }
  return order;
}

/**
 * Pull decision-makers for one account through the workspace's configured
 * provider(s), link + score each, and write a `contacts_completed` audit fact
 * either way. Tries providers in order (primary, then fallback) and stops at
 * the first that returns contacts — so an Explorium-first, Hunter-fallback
 * workspace only spends Hunter credits when Explorium found nobody.
 *
 * Single source of truth for a contact pull: both the Inngest contactsRunner
 * and the daily loop call this, so behavior can't drift between the two.
 */
export async function pullContactsForAccount(
  supabase: SupabaseClient,
  args: { workspace_id: string; entity_id: string },
): Promise<PullContactsResult> {
  const { workspace_id, entity_id } = args;
  const actor = { workspace_id, actor_kind: 'agent' as const, actor_id: 'contacts_runner' };

  async function audit(text: string): Promise<void> {
    // Records that a contact pull attempt finished (and how) — what the system
    // did, not a fact about the account, so it goes to the event log. The sweep
    // contact-pull health check reads it back by action name. summary carries
    // the text the error-share check greps.
    await recordActivityMarker(supabase, actor, ACTIVITY_MARKERS.CONTACTS_COMPLETED, entity_id, {
      summary: text.slice(0, 200),
    });
  }

  const ent = await supabase.from('entities').select('attributes').eq('id', entity_id).maybeSingle();
  const domain = (ent.data?.attributes as { domain?: string } | null)?.domain;
  if (!domain) { await audit('no domain on account'); return { ok: false, reason: 'no domain', found: 0, created: 0 }; }

  const policy = await getPolicy(supabase, workspace_id);
  const order = providerOrder(policy);
  if (!order.length) { await audit('no contact_provider configured'); return { ok: false, reason: 'no contact_provider', found: 0, created: 0 }; }

  // Monthly lookup cap. This path is the one the daily advance pass drives, and
  // it used to ignore the cap entirely: the check lived only in agent_logic's
  // maybeLinkContactsForEntity, and the counter it reads (contact_lookup_attempted
  // facts) was never written here. Measured on Sudden in July: cap 15, counter
  // reading 0, and 152 pulls actually made — ten times the configured budget,
  // which is how a paid contact provider quietly runs dry.
  //
  // Same predicate and same calendar-month window as the other path, so the two
  // share one budget instead of each keeping its own.
  const monthlyCap = policy.enrichment?.hunter_monthly_cap ?? 0;
  if (monthlyCap > 0) {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const usage = await supabase.from('facts')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspace_id)
      .eq('predicate', 'contact_lookup_attempted')
      .gte('observed_at', monthStart);
    const used = usage.count ?? 0;
    if (used >= monthlyCap) {
      await audit(`monthly lookup cap reached (${used}/${monthlyCap})`);
      return { ok: true, reason: 'monthly cap reached', found: 0, created: 0 };
    }
  }

  let pulled: Array<{ name: string; email: string; role: string }> = [];
  let usedProvider = '';
  const errors: string[] = [];
  for (const provider of order) {
    try {
      if (provider === 'hunter') {
        const apiKey = resolveEnvVar(policy, 'HUNTER_API_KEY');
        if (!apiKey) { errors.push('hunter: HUNTER_API_KEY not set'); continue; }
        const cs = await findContacts({ domain, apiKey, limit: MAX_CONTACTS_PER_ACCOUNT, role_filter: 'founder' });
        pulled = cs.filter((c) => c.email).map((c) => ({ name: c.name, email: c.email, role: c.role }));
      } else if (provider === 'explorium') {
        const apiKey = resolveEnvVar(policy, 'EXPLORIUM_API_KEY');
        if (!apiKey) { errors.push('explorium: EXPLORIUM_API_KEY not set'); continue; }
        pulled = await findContactsExplorium({ domain, apiKey, limit: MAX_CONTACTS_PER_ACCOUNT, role_filter: 'founder' });
      } else {
        continue;
      }
      usedProvider = provider;
      // A call went out and the provider's quota was spent, whatever it
      // returned. Record it against the shared monthly counter here rather than
      // only on success — a lookup that finds nobody still costs a credit, and
      // counting only the hits is how the budget silently overruns.
      await act(supabase, actor, {
        tool: 'assert_fact',
        args: {
          subject_entity: entity_id,
          predicate: 'contact_lookup_attempted',
          object_text: new Date().toISOString(),
          confidence: 1,
        },
      }).catch(() => { /* the pull itself matters more than its bookkeeping */ });
      if (pulled.length) break; // got contacts — don't spend the fallback
    } catch (e) {
      errors.push(`${provider}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (!pulled.length) {
    const msg = errors.length ? `no contacts; ${errors.join('; ')}` : `no contacts found via ${order.join('/')}`;
    await audit(msg);
    // ok:false only when a provider actually errored, so the health sweep can
    // tell a real failure (bad key, quota) from a clean "matched, found nobody".
    // error_detail carries the raw text so the advance pass can tell a halting
    // credit/auth failure from a benign "found nobody".
    return { ok: errors.length === 0, reason: errors.length ? 'provider error' : 'no contacts found', error_detail: errors.length ? errors.join('; ') : undefined, provider: usedProvider || order[0], found: 0, created: 0 };
  }

  let created = 0;
  for (const c of pulled) {
    try {
      const r = await linkContactToAccount(supabase, actor, { account_entity_id: entity_id, name: c.name, email: c.email, role: c.role });
      if (r.created && r.contact_entity_id) { await scoreAndAssert(supabase, actor, r.contact_entity_id); created++; }
    } catch { /* skip one bad contact; the rest still land */ }
  }
  await audit(`${created} new contact(s) via ${usedProvider} (${pulled.length} found)`);
  return { ok: true, provider: usedProvider, found: pulled.length, created };
}
