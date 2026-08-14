/**
 * Tool registry for the global chat agent.
 *
 * Each entry is:
 *   - spec: the function-calling description the model sees
 *   - run:  the server-side handler that executes the call
 *
 * One `query` tool replaces the prior per-tab read tools (lookup_entity,
 * get_entity, top_entities, source_health, recent_agent_actions). The model
 * picks a scope + filter; the dispatcher routes to the right reader.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  callTool, scoreAndAssert, selectAction, buildThresholds, loadActionContext, loadBestContactScore,
  lookupEntity, getPolicy, resolveEnvVar,
  chatCompleteForWorkspace, getSourceMetrics,
  findContacts, linkContactToAccount,
  getEntityTypes, getEntityTypesBatch, entityIdsOfType, breakdownFromFacts,
} from '@agent-crm/tools';
import { relatedToEntity, excludeSuperseded } from '@agent-crm/primitives';
import { type ToolSpec } from '@agent-crm/primitives';
import { runQualification } from '@agent-crm/agents';
import { inngest } from '@agent-crm/inngest';
import {
  TOOLKITS as COMPOSIO_TOOLKITS,
  execute as composioExecute,
  findAction as findComposioAction,
} from '@agent-crm/composio';

type Actor = { workspace_id: string; actor_kind: 'user'; actor_id: string };

export interface ToolRunCtx {
  supabase: SupabaseClient;
  actor: Actor;
  workspace_id: string;
}

export interface ToolHandler {
  spec: ToolSpec;
  run: (ctx: ToolRunCtx, args: any) => Promise<unknown>;
}

// ---------------------------------------------------------------
// query — generalized read dispatcher
// ---------------------------------------------------------------

type QueryScope = 'entities' | 'facts' | 'events' | 'sources' | 'gates' | 'contacts' | 'drafts';

interface QueryArgs {
  scope: QueryScope;
  filter?: {
    id?: string;            // specific entity / fact / event id
    name_match?: string;    // fuzzy name search (entities scope)
    kind?: string;          // entities scope
    min_score?: number;     // entities scope (icp_fit floor)
    predicate?: string;     // facts scope
    subject_entity?: string;// facts scope
    action?: string;        // events scope (e.g., 'agent_action_taken', 'assert_fact')
    status?: string;        // gates scope ('pending' | 'decided')
    since_hours?: number;   // events / gates window
    // contacts scope:
    account_entity_id?: string;
    account_name?: string;
    include_unlinked?: boolean;  // default true — also pull contact-kind entities whose email matches the account's domain
    role_filter?: string;        // contacts scope post-filter on role/seniority
    // entities scope — graph-ish filter for "anyone with predicate=X" walks
    has_fact?: { predicate: string; object_match?: string };
  };
  sort?: 'icp_total desc' | 'updated_at desc' | 'created_at desc';
  limit?: number;
}

const queryTool: ToolHandler = {
  spec: {
    name: 'query',
    description:
`Generalized read across workspace state. Pick a scope and filter; one call covers entity lookups, ranked entity lists, fact reads, recent events, source health, and gate status.

EXAMPLES (always pass scope; other params optional):
  query({ scope: "entities", sort: "icp_total desc", limit: 5 })           // top entities
  query({ scope: "entities", filter: { name_match: "apollo" } })           // find by name
  query({ scope: "entities", filter: { id: "<uuid>" } })                   // single entity + facts
  query({ scope: "entities", filter: { has_fact: { predicate: "industry", object_match: "ai" } } })  // accounts with industry containing "ai"
  query({ scope: "facts", filter: { subject_entity: "<uuid>" } })          // all facts on an entity
  query({ scope: "facts", filter: { predicate: "hiring_for" }, limit: 20 })// facts by predicate
  query({ scope: "events", filter: { action: "agent_action_taken", since_hours: 24 } })
  query({ scope: "sources" })                                              // per-source health
  query({ scope: "gates", filter: { status: "pending" } })                 // pending approvals
  query({ scope: "contacts", filter: { account_name: "anthropic" } })      // contacts/team/people at X (resolves account by name)
  query({ scope: "contacts", filter: { account_entity_id: "<uuid>" } })    // contacts for a known account id
  query({ scope: "contacts", filter: { account_entity_id: "<uuid>", role_filter: "founder" } })
  query({ scope: "drafts", limit: 5 })                                     // recent outbound drafts the agent wrote
  query({ scope: "drafts", filter: { subject_entity: "<uuid>" } })         // drafts for one entity

Result shape: { scope, rows: [...] }. Row shape varies by scope — entities have icp_fit, facts have predicate/object_text, events have action/payload, sources have signals/agent_runs/facts counts, gates have policy/decision, contacts have name/email/role/link_source, drafts have body/cites/entity_id.`,
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['entities', 'facts', 'events', 'sources', 'gates', 'contacts', 'drafts'] },
        filter: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name_match: { type: 'string' },
            kind: { type: 'string' },
            min_score: { type: 'number' },
            predicate: { type: 'string' },
            subject_entity: { type: 'string' },
            action: { type: 'string' },
            status: { type: 'string' },
            since_hours: { type: 'number' },
            account_entity_id: { type: 'string' },
            account_name: { type: 'string' },
            include_unlinked: { type: 'boolean' },
            role_filter: { type: 'string' },
            has_fact: {
              type: 'object',
              properties: {
                predicate: { type: 'string' },
                object_match: { type: 'string' },
              },
              required: ['predicate'],
            },
          },
        },
        sort: { type: 'string', enum: ['icp_total desc', 'updated_at desc', 'created_at desc'] },
        limit: { type: 'number' },
      },
      required: ['scope'],
    },
  },
  run: async (ctx, args: QueryArgs) => {
    const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
    switch (args.scope) {
      case 'entities': return await queryEntities(ctx, args.filter ?? {}, args.sort, limit);
      case 'facts':    return await queryFacts(ctx, args.filter ?? {}, limit);
      case 'events':   return await queryEvents(ctx, args.filter ?? {}, limit);
      case 'sources':  return await querySources(ctx, args.filter ?? {});
      case 'gates':    return await queryGates(ctx, args.filter ?? {}, limit);
      case 'contacts': return await queryContacts(ctx, args.filter ?? {}, limit);
      case 'drafts':   return await queryDrafts(ctx, args.filter ?? {}, limit);
      default:         return { error: `unknown scope: ${(args as { scope?: string }).scope}` };
    }
  },
};

async function queryEntities(
  ctx: ToolRunCtx,
  filter: NonNullable<QueryArgs['filter']>,
  sort: QueryArgs['sort'],
  limit: number,
): Promise<unknown> {
  // 1) Single entity by id — return entity + active facts.
  if (filter.id) {
    const ent = await ctx.supabase.from('entities')
      .select('id, name, attributes')
      .eq('id', filter.id).maybeSingle();
    if (!ent.data) return { scope: 'entities', rows: [], error: 'entity not found' };
    // `supersedes is null` returns the STALE ORIGINAL fact, not the current one
    // (supersede_fact writes the new row pointing back at the old id) - the
    // current fact is whichever one nothing else points to. Same convention as
    // reads.ts getEntity / relations.ts excludeSuperseded.
    const factRows = await ctx.supabase.from('facts')
      .select('id, predicate, object_text, confidence, observed_at, supersedes')
      .eq('subject_entity', filter.id).limit(500);
    const allFacts = (factRows.data ?? []) as Array<{ id: string; predicate: string; object_text: string | null; confidence: number; observed_at: string; supersedes: string | null }>;
    const supersededIds = new Set(allFacts.map((f) => f.supersedes).filter((x): x is string => !!x));
    const facts = allFacts.filter((f) => !supersededIds.has(f.id)).slice(0, 50);
    const types = await getEntityTypes(ctx.supabase, filter.id);
    return { scope: 'entities', rows: [{ ...ent.data, kind: types[0] ?? 'entity', types, facts }] };
  }

  // 2) Name match — fuzzy ILIKE.
  if (filter.name_match) {
    const matches = await lookupEntity(ctx.supabase, ctx.workspace_id, {
      name: filter.name_match, fuzzy: true, limit,
    });
    return { scope: 'entities', rows: matches };
  }

  // 2b) Has-fact filter — entities with an active fact matching predicate (and optional object substring).
  if (filter.has_fact?.predicate) {
    let fq = ctx.supabase.from('facts')
      .select('subject_entity, predicate, object_text')
      .eq('workspace_id', ctx.workspace_id)
      .eq('predicate', filter.has_fact.predicate)
      .is('supersedes', null)
      .limit(500);
    if (filter.has_fact.object_match) fq = fq.ilike('object_text', `%${filter.has_fact.object_match}%`);
    const { data: matchedFacts, error: fErr } = await fq;
    if (fErr) return { scope: 'entities', error: fErr.message };
    const ids = Array.from(new Set((matchedFacts ?? []).map((f) => f.subject_entity as string)));
    if (ids.length === 0) return { scope: 'entities', rows: [], note: `no entities with ${filter.has_fact.predicate}${filter.has_fact.object_match ? ` ~ "${filter.has_fact.object_match}"` : ''}` };
    const { data: ents, error: eErr } = await ctx.supabase.from('entities')
      .select('id, name, attributes, archived_at').in('id', ids).is('archived_at', null);
    if (eErr) return { scope: 'entities', error: eErr.message };
    const entRows = (ents ?? []) as Array<{ id: string; name: string }>;
    const typesById = await getEntityTypesBatch(ctx.supabase, entRows.map((e) => e.id));
    const filtered = filter.kind
      ? entRows.filter((e) => (typesById.get(e.id) ?? []).includes(filter.kind!))
      : entRows;
    return { scope: 'entities', rows: filtered.slice(0, limit).map((e) => ({ entity_id: e.id, name: e.name, kind: (typesById.get(e.id) ?? [])[0] ?? 'entity' })) };
  }

  // 3) Ranked list — by icp_fit.
  const minScore = filter.min_score ?? 0;
  const { data: scoreRows, error } = await ctx.supabase.from('facts')
    .select('subject_entity, object_text')
    .eq('workspace_id', ctx.workspace_id)
    .eq('predicate', 'icp_fit')
    .is('supersedes', null);
  if (error) return { scope: 'entities', error: error.message };

  const ranked = (scoreRows ?? [])
    .map((r) => ({ entity_id: r.subject_entity as string, icp_fit: Number(r.object_text) }))
    .filter((r) => Number.isFinite(r.icp_fit) && r.icp_fit >= minScore)
    .sort((a, b) => b.icp_fit - a.icp_fit);

  if (ranked.length === 0) {
    return { scope: 'entities', rows: [], note: 'no scored entities yet' };
  }

  const topIds = ranked.slice(0, limit * 3).map((r) => r.entity_id);
  const entRes = await ctx.supabase.from('entities')
    .select('id, name, archived_at').in('id', topIds);
  const byId = new Map<string, { id: string; name: string; archived_at: string | null }>();
  for (const e of (entRes.data ?? []) as Array<{ id: string; name: string; archived_at: string | null }>) {
    byId.set(e.id, e);
  }
  const typesById = await getEntityTypesBatch(ctx.supabase, topIds);
  const rows = ranked
    .map((r) => {
      const e = byId.get(r.entity_id);
      if (!e || e.archived_at) return null;
      const kinds = typesById.get(e.id) ?? [];
      if (filter.kind && !kinds.includes(filter.kind)) return null;
      return { entity_id: r.entity_id, name: e.name, kind: kinds[0] ?? 'entity', icp_fit: r.icp_fit };
    })
    .filter((x): x is { entity_id: string; name: string; kind: string; icp_fit: number } => x !== null)
    .slice(0, limit);

  return { scope: 'entities', rows, total_scored: ranked.length, sort: sort ?? 'icp_total desc' };
}

async function queryFacts(
  ctx: ToolRunCtx,
  filter: NonNullable<QueryArgs['filter']>,
  limit: number,
): Promise<unknown> {
  let q = ctx.supabase.from('facts')
    .select('id, predicate, object_text, subject_entity, confidence, observed_at')
    .eq('workspace_id', ctx.workspace_id)
    .is('supersedes', null)
    .order('observed_at', { ascending: false })
    .limit(limit);
  if (filter.subject_entity) q = q.eq('subject_entity', filter.subject_entity);
  if (filter.predicate) q = q.eq('predicate', filter.predicate);
  const { data, error } = await q;
  if (error) return { scope: 'facts', error: error.message };
  return { scope: 'facts', rows: data ?? [] };
}

async function queryEvents(
  ctx: ToolRunCtx,
  filter: NonNullable<QueryArgs['filter']>,
  limit: number,
): Promise<unknown> {
  let q = ctx.supabase.from('events')
    .select('id, action, target_kind, target_id, payload, created_at, actor_kind, actor_id')
    .eq('workspace_id', ctx.workspace_id)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (filter.action) q = q.eq('action', filter.action);
  if (filter.since_hours) {
    const since = new Date(Date.now() - filter.since_hours * 3600 * 1000).toISOString();
    q = q.gte('created_at', since);
  }
  const { data, error } = await q;
  if (error) return { scope: 'events', error: error.message };

  // For agent_action_taken, fold in the undone flag (matches recent_agent_actions behavior).
  if (filter.action === 'agent_action_taken') {
    const undoRes = await ctx.supabase.from('events')
      .select('payload').eq('workspace_id', ctx.workspace_id).eq('action', 'agent_action_undone').limit(500);
    const undone = new Set<string>();
    for (const u of (undoRes.data ?? []) as Array<{ payload: { original_event_id?: string } | null }>) {
      const id = u.payload?.original_event_id;
      if (id) undone.add(String(id));
    }
    const rows = (data ?? []).map((row: any) => ({
      event_id: row.id,
      taken_at: row.created_at,
      action_type: row.payload?.action_type ?? 'unknown',
      source_name: row.payload?.source_name ?? '(unknown)',
      reasoning: row.payload?.reasoning ?? '',
      undone: undone.has(String(row.id)),
    }));
    return { scope: 'events', rows };
  }

  return { scope: 'events', rows: data ?? [] };
}

async function querySources(
  ctx: ToolRunCtx,
  filter: NonNullable<QueryArgs['filter']>,
): Promise<unknown> {
  const window_hours = filter.since_hours ?? 168;
  const rows = await getSourceMetrics(ctx.supabase, ctx.workspace_id, window_hours);
  rows.sort((a, b) => b.signals - a.signals);
  return { scope: 'sources', window_hours, rows };
}

async function queryGates(
  ctx: ToolRunCtx,
  filter: NonNullable<QueryArgs['filter']>,
  limit: number,
): Promise<unknown> {
  let q = ctx.supabase.from('gates')
    .select('id, policy, condition, requested_at, decided_at, decision, requested_by_agent', { count: 'exact' })
    .eq('workspace_id', ctx.workspace_id)
    .order('requested_at', { ascending: false })
    .limit(limit);
  if (filter.status === 'pending') q = q.is('decided_at', null);
  if (filter.status === 'decided') q = q.not('decided_at', 'is', null);
  if (filter.since_hours) {
    const since = new Date(Date.now() - filter.since_hours * 3600 * 1000).toISOString();
    q = q.gte('requested_at', since);
  }
  const { data, error, count } = await q;
  if (error) return { scope: 'gates', error: error.message };
  const rows = data ?? [];
  // total lets the model see truncation — without it, "X isn't in the rows"
  // becomes a confident wrong negative when total > limit.
  return {
    scope: 'gates', total: count ?? rows.length, rows,
    ...(count != null && count > rows.length ? { note: `showing ${rows.length} of ${count}; raise limit or filter to see the rest` } : {}),
  };
}

async function queryDrafts(
  ctx: ToolRunCtx,
  filter: NonNullable<QueryArgs['filter']>,
  limit: number,
): Promise<unknown> {
  // FK-join scoping instead of prefetching channel ids: workspaces past
  // ~1000 channels made the .in(channelIds) URL exceed PostgREST's limit
  // ("Bad Request") and the prefetch itself silently capped at 1000 rows.
  let q = ctx.supabase.from('channel_posts')
    .select('id, channel_id, body, cites, created_at, author_id, channels!inner(workspace_id, account_entity_id)', { count: 'exact' })
    .eq('channels.workspace_id', ctx.workspace_id)
    .eq('kind', 'touch_draft')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (filter.subject_entity) {
    q = q.eq('channels.account_entity_id', filter.subject_entity);
  }
  if (filter.since_hours) {
    const since = new Date(Date.now() - filter.since_hours * 3600 * 1000).toISOString();
    q = q.gte('created_at', since);
  }
  const { data, error, count } = await q;
  if (error) return { scope: 'drafts', error: error.message };

  const rows = (data ?? []).map((p) => ({
    id: p.id,
    entity_id: (p.channels as unknown as { account_entity_id?: string | null })?.account_entity_id ?? null,
    body: p.body,
    cites: p.cites ?? [],
    created_at: p.created_at,
    author: p.author_id,
  }));
  return {
    scope: 'drafts', total: count ?? rows.length, rows,
    ...(count != null && count > rows.length ? { note: `showing ${rows.length} of ${count}; raise limit or filter to see the rest` } : {}),
  };
}

function isPlaceholderDomain(d: string | undefined | null): boolean {
  if (!d) return true;
  return /\.example$/i.test(d);
}

async function queryContacts(
  ctx: ToolRunCtx,
  filter: NonNullable<QueryArgs['filter']>,
  limit: number,
): Promise<unknown> {
  // 1) Resolve account.
  let accountId = filter.account_entity_id;
  if (!accountId && filter.account_name) {
    const raw = await lookupEntity(ctx.supabase, ctx.workspace_id, {
      name: filter.account_name, fuzzy: true, limit: 8,
    });
    const matches = raw.filter((m) => m.kind === 'account').slice(0, 3);
    if (matches.length === 0) {
      return { scope: 'contacts', rows: [], note: `no account matched "${filter.account_name}"` };
    }
    if (matches.length > 1) {
      return {
        scope: 'contacts',
        rows: [],
        candidates: matches.map((m) => ({ entity_id: m.entity_id, name: m.name })),
        note: `ambiguous account "${filter.account_name}" — pick one and re-query with account_entity_id`,
      };
    }
    accountId = matches[0]!.entity_id;
  }
  if (!accountId) {
    return { scope: 'contacts', error: 'pass account_entity_id or account_name' };
  }

  const acctRes = await ctx.supabase.from('entities')
    .select('id, name, attributes')
    .eq('id', accountId).maybeSingle();
  if (!acctRes.data) return { scope: 'contacts', rows: [], note: `account ${accountId} not found` };
  const account = acctRes.data as { id: string; name: string; attributes: Record<string, unknown> };
  const rawDomain = (account.attributes?.domain as string | undefined) ?? null;
  const domain = isPlaceholderDomain(rawDomain) ? null : rawDomain;

  // 2) Linked contacts: any entity linked to the account whose kind is contact.
  //    Open vocab — the relationship type may be works_at or anything coined.
  const linked = (await relatedToEntity(ctx.supabase, ctx.workspace_id, accountId)).filter((r) => r.kind === 'contact');
  const linkedIds = new Set(linked.map((r) => r.entity_id));

  // 3) Unlinked contacts via email-domain heuristic (only if account has a real domain).
  let unlinkedRows: Array<{ entity_id: string; email: string }> = [];
  const includeUnlinked = filter.include_unlinked !== false;
  if (includeUnlinked && domain) {
    const { data: emailFacts } = await ctx.supabase.from('facts')
      .select('subject_entity, object_text')
      .eq('workspace_id', ctx.workspace_id)
      .eq('predicate', 'email')
      .ilike('object_text', `%@${domain}`)
      .is('supersedes', null)
      .limit(200);
    const candidateIds = Array.from(new Set(((emailFacts ?? []) as Array<{ subject_entity: string; object_text: string }>)
      .map((f) => f.subject_entity)
      .filter((id) => !linkedIds.has(id))));
    if (candidateIds.length > 0) {
      const contactIds = new Set(await entityIdsOfType(ctx.supabase, ctx.workspace_id, 'contact'));
      const { data: contactEnts } = await ctx.supabase.from('entities')
        .select('id').in('id', candidateIds.filter((id) => contactIds.has(id))).is('archived_at', null);
      const okIds = new Set((contactEnts ?? []).map((e) => e.id as string));
      for (const f of (emailFacts ?? []) as Array<{ subject_entity: string; object_text: string }>) {
        if (okIds.has(f.subject_entity) && !linkedIds.has(f.subject_entity)) {
          unlinkedRows.push({ entity_id: f.subject_entity, email: f.object_text });
        }
      }
    }
  }

  // 4) Inline key facts (email, role, seniority, linkedin_url) for every contact.
  const allIds = Array.from(new Set([...linkedIds, ...unlinkedRows.map((r) => r.entity_id)]));
  const factsByEntity = new Map<string, Array<{ predicate: string; object_text: string | null }>>();
  if (allIds.length > 0) {
    const { data: factsData } = await ctx.supabase.from('facts')
      .select('subject_entity, predicate, object_text')
      .eq('workspace_id', ctx.workspace_id)
      .in('subject_entity', allIds)
      .in('predicate', ['email', 'role', 'title', 'seniority', 'linkedin_url'])
      .is('supersedes', null);
    for (const f of (factsData ?? []) as Array<{ subject_entity: string; predicate: string; object_text: string | null }>) {
      const arr = factsByEntity.get(f.subject_entity) ?? [];
      arr.push({ predicate: f.predicate, object_text: f.object_text });
      factsByEntity.set(f.subject_entity, arr);
    }
  }
  const ent = (id: string) => factsByEntity.get(id) ?? [];
  const findFact = (id: string, p: string) => ent(id).find((f) => f.predicate === p)?.object_text ?? null;

  // Lookup contact names from entities table.
  const nameById = new Map<string, string>();
  if (allIds.length > 0) {
    const { data: ents } = await ctx.supabase.from('entities').select('id, name').in('id', allIds);
    for (const e of (ents ?? []) as Array<{ id: string; name: string }>) nameById.set(e.id, e.name);
  }

  let rows = linked.map((r) => ({
    entity_id: r.entity_id,
    name: nameById.get(r.entity_id) ?? r.name,
    email: findFact(r.entity_id, 'email'),
    role: findFact(r.entity_id, 'role') ?? findFact(r.entity_id, 'title'),
    seniority: findFact(r.entity_id, 'seniority'),
    linkedin_url: findFact(r.entity_id, 'linkedin_url'),
    link_source: r.via_predicate,
    via_fact_id: r.via_fact_id as string | null,
    confidence: r.confidence,
  }));
  for (const u of unlinkedRows) {
    rows.push({
      entity_id: u.entity_id,
      name: nameById.get(u.entity_id) ?? '(unknown)',
      email: u.email,
      role: findFact(u.entity_id, 'role') ?? findFact(u.entity_id, 'title'),
      seniority: findFact(u.entity_id, 'seniority'),
      linkedin_url: findFact(u.entity_id, 'linkedin_url'),
      link_source: 'email_domain',
      via_fact_id: null,
      confidence: 0.6,
    });
  }

  // 5) Optional role_filter — post-filter on role/seniority text.
  if (filter.role_filter) {
    const needle = filter.role_filter.toLowerCase();
    rows = rows.filter((r) => (r.role ?? '').toLowerCase().includes(needle) || (r.seniority ?? '').toLowerCase().includes(needle));
  }

  return {
    scope: 'contacts',
    account: { entity_id: account.id, name: account.name, domain: domain ?? null },
    linked_count: linked.length,
    domain_only_count: unlinkedRows.length,
    rows: rows.slice(0, limit),
    note: !domain ? 'account has no real domain — domain-based contact discovery skipped' : undefined,
  };
}

// ---------------------------------------------------------------
// Write / agent-boundary tools (kept separate from `query`)
// ---------------------------------------------------------------

const createAccountTool: ToolHandler = {
  spec: {
    name: 'create_account',
    description: 'Create a NEW account entity. Use only when query({scope:"entities", filter:{name_match}}) returns no match and you are confident the user is referring to a new company. Returns the new entity_id.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        domain: { type: 'string', description: 'Optional. Normalized hostname like "apollo.io".' },
      },
      required: ['name'],
    },
  },
  run: async (ctx, args: { name: string; domain?: string }) => {
    const attributes: Record<string, unknown> = {
      _discovered_via: 'chat_intake',
      discovered_at: new Date().toISOString(),
    };
    if (args.domain) attributes.domain = args.domain;
    const r = await callTool(ctx.supabase, ctx.actor, 'create_account', { name: args.name, attributes });
    if (!r.ok) return { error: r.error };
    return { entity_id: r.target_id, name: args.name };
  },
};

const enrichContactsTool: ToolHandler = {
  spec: {
    name: 'enrich_contacts',
    description:
`Find contacts for an account via Hunter.io and link them as contact entities + works_at facts. Reversible (creates entities and facts; can be undone). Reads the account's domain from entities.attributes.domain — fails if no real domain set. Call when contacts(scope) returns 0 linked AND the account has a real domain. Returns { domain, found, created, existed, contacts }.`,
    parameters: {
      type: 'object',
      properties: {
        account_entity_id: { type: 'string' },
        limit: { type: 'number', description: 'Max contacts to pull (default 5).' },
        role_filter: { type: 'string', description: 'Optional role substring (e.g., "founder", "engineering").' },
      },
      required: ['account_entity_id'],
    },
  },
  run: async (ctx, args: { account_entity_id: string; limit?: number; role_filter?: string }) => {
    const acctRes = await ctx.supabase.from('entities')
      .select('id, name, attributes').eq('id', args.account_entity_id).maybeSingle();
    if (!acctRes.data) return { error: `account ${args.account_entity_id} not found` };
    const acct = acctRes.data as { id: string; name: string; attributes: Record<string, unknown> };
    const rawDomain = (acct.attributes?.domain as string | undefined) ?? null;
    if (!rawDomain || /\.example$/i.test(rawDomain)) {
      return { error: `account "${acct.name}" has no real domain — set entities.attributes.domain first` };
    }
    let contacts;
    try {
      const policy = await getPolicy(ctx.supabase, ctx.workspace_id);
      contacts = await findContacts({ domain: rawDomain, limit: args.limit ?? 5, role_filter: args.role_filter, apiKey: resolveEnvVar(policy, 'HUNTER_API_KEY') });
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
    let created = 0; let existed = 0;
    const linkedRows: Array<{ contact_entity_id: string; name: string; email: string; role?: string; created: boolean }> = [];
    for (const c of contacts) {
      try {
        const r = await linkContactToAccount(ctx.supabase, ctx.actor, {
          account_entity_id: args.account_entity_id,
          name: c.name, email: c.email, role: c.role || undefined,
        });
        // skipped = role inbox / no name — don't surface or count it.
        if (r.skipped || !r.contact_entity_id) continue;
        if (r.created) created++; else existed++;
        linkedRows.push({ contact_entity_id: r.contact_entity_id, name: c.name, email: c.email, role: c.role, created: r.created });
      } catch (e) {
        // skip individual failures; report the rest
      }
    }
    return {
      domain: rawDomain,
      found: contacts.length,
      created, existed,
      contacts: linkedRows,
    };
  },
};

const extractFactsTool: ToolHandler = {
  spec: {
    name: 'extract_facts',
    description: 'Read a free-text observation about an entity and propose atomic facts to assert. Use this AFTER identifying the entity. Does NOT write anything — returns proposed facts for the user to confirm.',
    parameters: {
      type: 'object',
      properties: {
        entity_id: { type: 'string' },
        entity_name: { type: 'string', description: 'For LLM context.' },
        text: { type: 'string', description: 'The free-text observation, tweet, article excerpt, or note.' },
      },
      required: ['entity_id', 'entity_name', 'text'],
    },
  },
  run: async (ctx, args: { entity_id: string; entity_name: string; text: string }) => {
    const sys = `You extract atomic factual claims about a specific company from a free-text observation.

ATOMIC = one predicate, one value. Not "uses postgres and redis." → two facts.
VERBATIM-GROUNDED = only what's stated or directly implied. No speculation.

Predicate examples (use snake_case, choose what fits — these are illustrative, not exhaustive):
  hiring_for, headcount, team_size, raised_round, launched_product, target_market,
  uses_stack, integrates_with, customer_of, sales_motion, founder, location

Output JSON: {"facts":[{"predicate":"<snake_case>","object_text":"<value>","confidence":0.0-1.0},...]}

Confidence: 0.95 explicit ("hiring a VP of Sales"), 0.7 implied ("their team of 12"). Skip lower.

If the observation is not about this company, return {"facts":[]}.`;

    const user = `Company: ${args.entity_name}
Observation:
"""
${args.text}
"""

Return JSON.`;

    try {
      const llm = await chatCompleteForWorkspace(ctx.supabase, ctx.workspace_id, {
        model: 'deepseek-v4-flash',
        behavior: 'intake',
        max_tokens: 800,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      });
      const parsed = JSON.parse(llm.text) as { facts?: Array<{ predicate: string; object_text: string; confidence?: number }> };
      return { facts: parsed.facts ?? [] };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e), facts: [] };
    }
  },
};

const assertFactsTool: ToolHandler = {
  spec: {
    name: 'assert_facts',
    description: 'Write a batch of facts about an entity. Idempotent on content hash. Call ONLY after the user has confirmed the proposed facts from extract_facts.',
    parameters: {
      type: 'object',
      properties: {
        entity_id: { type: 'string' },
        facts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              predicate: { type: 'string' },
              object_text: { type: 'string' },
              confidence: { type: 'number' },
            },
            required: ['predicate', 'object_text'],
          },
        },
      },
      required: ['entity_id', 'facts'],
    },
  },
  run: async (ctx, args: { entity_id: string; facts: Array<{ predicate: string; object_text: string; confidence?: number }> }) => {
    let asserted = 0;
    const errors: string[] = [];
    for (const f of args.facts) {
      if (!f.predicate || !f.object_text) { errors.push(`skipped invalid fact: ${JSON.stringify(f)}`); continue; }
      const conf = typeof f.confidence === 'number' ? Math.max(0, Math.min(1, f.confidence)) : 0.85;
      const r = await callTool(ctx.supabase, ctx.actor, 'assert_fact', {
        subject_entity: args.entity_id,
        predicate: f.predicate.toLowerCase().replace(/\s+/g, '_'),
        object_text: f.object_text,
        confidence: conf,
      });
      if (r.ok) asserted++;
      else errors.push(r.error ?? 'unknown');
    }
    return { asserted, errors };
  },
};

const rescoreTool: ToolHandler = {
  spec: {
    name: 'rescore_entity',
    description: 'Recompute the entity score from its current active facts. Call this AFTER assert_facts so the new facts feed into the score.',
    parameters: {
      type: 'object',
      properties: { entity_id: { type: 'string' } },
      required: ['entity_id'],
    },
  },
  run: async (ctx, args: { entity_id: string }) => {
    const r = await scoreAndAssert(ctx.supabase, { ...ctx.actor, actor_kind: 'user' }, args.entity_id);
    if (!r) return { error: 'scoring returned null (entity may be dropped)' };
    return { icp_total: r.icp_total, breakdown: r.breakdown };
  },
};

const proposeActionTool: ToolHandler = {
  spec: {
    name: 'propose_action',
    description: 'Evaluate what the action selector would do for this entity right now. Returns the categorical action (draft_outreach / enrich_contacts / watch_only / deep_research / drop / continue) plus reason and matched value theme if any. enrich_contacts means the account fits but lacks a strong enough contact to email — find a better decision-maker first. Call AFTER rescore_entity.',
    parameters: {
      type: 'object',
      properties: { entity_id: { type: 'string' } },
      required: ['entity_id'],
    },
  },
  run: async (ctx, args: { entity_id: string }) => {
    // `.is('supersedes', null)` returns the STALE ORIGINAL: supersede_fact
    // writes the new row pointing at the old one, so the original keeps a null
    // supersedes forever. This tool was previewing the action selector against
    // whatever score the entity had on its very first pass.
    const factsRes = await ctx.supabase.from('facts')
      .select('id, predicate, object_text')
      .eq('workspace_id', ctx.workspace_id).eq('subject_entity', args.entity_id);
    const facts = await excludeSuperseded(ctx.supabase, ctx.workspace_id,
      (factsRes.data ?? []) as Array<{ id: string; predicate: string; object_text: string | null }>);
    const readScore = (p: string) => {
      const f = facts.find((x) => x.predicate === p);
      const v = f ? parseFloat(f.object_text ?? '') : NaN;
      return Number.isFinite(v) ? v : 0;
    };
    // Via breakdownFromFacts so unknown_dims survives: the score_* rows store a
    // placeholder 0 for a dimension that could not be measured, and averaging
    // that in gives the selector a lower total than the one production scored.
    const breakdown = breakdownFromFacts(facts)?.breakdown ?? {
      industry_match: 0, stage_match: 0, signal_strength: 0,
      evidence_depth: 0, recency: 0, graph_proximity: 0, rrf_prefilter: 0,
    };
    const icpTotal = readScore('score_total') || readScore('icp_fit');

    const chan = await ctx.supabase.from('channels').select('id')
      .eq('workspace_id', ctx.workspace_id).eq('account_entity_id', args.entity_id).maybeSingle();
    const channel_id = chan.data?.id as string | undefined;
    const channelCtx = channel_id
      ? await loadActionContext(ctx.supabase, ctx.workspace_id, args.entity_id, channel_id)
      : { recent_draft_at: null, recent_research_at: null, recent_contacts_request_at: null, dropped_until: null, cooldown_until: null };

    const policy = await getPolicy(ctx.supabase, ctx.workspace_id);

    const bestContactScore = await loadBestContactScore(ctx.supabase, ctx.workspace_id, args.entity_id);
    const decision = selectAction({
      workspace_id: ctx.workspace_id,
      entity_id: args.entity_id,
      breakdown, icp_total: icpTotal,
      best_contact_score: bestContactScore,
      recent_draft_at: channelCtx.recent_draft_at,
      recent_research_at: channelCtx.recent_research_at,
      recent_contacts_request_at: channelCtx.recent_contacts_request_at,
      dropped_until: channelCtx.dropped_until,
      cooldown_until: channelCtx.cooldown_until,
      thresholds: buildThresholds(policy.routing),
    });

    return {
      icp_total: icpTotal,
      breakdown,
      decision,
    };
  },
};

const triggerDrafterTool: ToolHandler = {
  spec: {
    name: 'trigger_drafter',
    description: 'Fire a drafter run for this entity. Picks up the drafter subscription and runs the same flow a real signal would. The draft will land in the Inbox as an outreach_send gate for human approval. Use ONLY when propose_action returned draft_outreach AND the user said go.',
    parameters: {
      type: 'object',
      properties: { entity_id: { type: 'string' } },
      required: ['entity_id'],
    },
  },
  run: async (ctx, args: { entity_id: string }) => {
    const sub = await ctx.supabase.from('subscriptions')
      .select('id, owner_id')
      .eq('workspace_id', ctx.workspace_id).eq('active', true).eq('agent_behavior', 'drafter')
      .limit(1).maybeSingle();
    if (!sub.data) return { error: 'no active drafter subscription in this workspace' };

    const sig = await ctx.supabase.from('signals').select('id, observed_at')
      .eq('workspace_id', ctx.workspace_id).eq('entity_id', args.entity_id)
      .order('observed_at', { ascending: false }).limit(1).maybeSingle();

    if (!sig.data?.id) {
      return { error: 'no recent signal for this entity — drafter needs one to anchor on. Wait for a source to fire or create_signal directly.' };
    }
    try {
      await inngest.send({
        name: 'agent.run',
        data: {
          workspace_id: ctx.workspace_id,
          agent: sub.data.owner_id as string,
          trigger_event: 'manual',
          subscription_id: sub.data.id as string,
          signal_id: sig.data.id as string,
        },
      });
      return { ok: true, subscription_id: sub.data.id, signal_id: sig.data.id };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  },
};

// ---------------------------------------------------------------
// composio_list_tools — discover available actions for a connected toolkit
// ---------------------------------------------------------------

const composioListToolsTool: ToolHandler = {
  spec: {
    name: 'composio_list_tools',
    description:
`List Composio actions available for a connected toolkit (Gmail, Slack, Salesforce, HubSpot, Google Calendar, …). Use BEFORE composio_execute to confirm the action slug + scope. Returns only actions for toolkits the workspace has actually connected.

Args: toolkit_slug (optional) — filter to one toolkit. Omit to list all connected toolkits.
Returns: { connected: [toolkit_slug...], actions: [{ toolkit, slug, scope, summary }] }.

Scope semantics:
  read       → runs immediately
  write      → runs unless workspace policy requires approval
  dangerous  → requires explicit approval (gate flow) — the agent should propose it and wait`,
    parameters: {
      type: 'object',
      properties: { toolkit_slug: { type: 'string' } },
    },
  },
  run: async (ctx, args: { toolkit_slug?: string }) => {
    const { data: conns } = await ctx.supabase
      .from('composio_connections')
      .select('toolkit_slug, status')
      .eq('workspace_id', ctx.workspace_id)
      .eq('status', 'active');
    const connected = new Set((conns ?? []).map((r) => r.toolkit_slug as string));
    const wanted = args.toolkit_slug?.toLowerCase();
    const actions: Array<{ toolkit: string; slug: string; scope: string; summary: string }> = [];
    for (const tk of Object.values(COMPOSIO_TOOLKITS)) {
      if (!connected.has(tk.slug)) continue;
      if (wanted && tk.slug !== wanted) continue;
      for (const a of tk.actions) {
        actions.push({ toolkit: tk.slug, slug: a.slug, scope: a.scope, summary: a.summary });
      }
    }
    return { connected: Array.from(connected), actions };
  },
};

// ---------------------------------------------------------------
// composio_execute — run an action on a connected toolkit
// ---------------------------------------------------------------

const composioExecuteTool: ToolHandler = {
  spec: {
    name: 'composio_execute',
    description:
`Execute a Composio action (e.g. GMAIL_FETCH_EMAILS, SLACK_LIST_ALL_USERS) against a workspace's connected account. The toolkit must be connected in workspace settings.

Args:
  action_slug (required) — uppercase Composio action id (e.g. "GMAIL_FETCH_EMAILS")
  arguments   (required) — JSON object matching the action's input schema

v1: read-only. Only actions returned by composio_list_tools are callable. Outbound (send / post / create) from a user's own account is not exposed yet.

Call composio_list_tools first if you don't know which action slug to use.`,
    parameters: {
      type: 'object',
      properties: {
        action_slug: { type: 'string' },
        arguments: { type: 'object' },
      },
      required: ['action_slug', 'arguments'],
    },
  },
  run: async (ctx, args: { action_slug: string; arguments: Record<string, unknown> }) => {
    const action_slug = args.action_slug?.toUpperCase();
    if (!action_slug) return { ok: false, error: 'action_slug required' };
    const found = findComposioAction(action_slug);
    if (!found) {
      return { ok: false, error: `unknown action: ${action_slug}. call composio_list_tools first.` };
    }
    const { toolkit, action } = found;

    const { data: conn } = await ctx.supabase
      .from('composio_connections')
      .select('id, status')
      .eq('workspace_id', ctx.workspace_id)
      .eq('toolkit_slug', toolkit.slug)
      .maybeSingle();
    if (!conn || conn.status !== 'active') {
      return { ok: false, error: `not connected to ${toolkit.slug}. ask the user to connect it in settings.` };
    }

    // v1 is read-only — the catalog only contains read actions, so this is a
    // belt-and-braces check that catches anything that slips in.
    if (action.scope !== 'read') {
      return {
        ok: false,
        error: `non-read actions are not exposed in v1 (action ${action_slug} is ${action.scope}).`,
      };
    }

    const result = await composioExecute(ctx.workspace_id, action_slug, args.arguments ?? {});

    await ctx.supabase.from('events').insert({
      workspace_id: ctx.workspace_id,
      actor_kind: 'agent',
      actor_id: 'composio',
      action: 'composio.execute',
      target_kind: 'composio_connection',
      target_id: conn.id,
      payload: {
        action_slug,
        toolkit_slug: toolkit.slug,
        scope: action.scope,
        arguments_preview: JSON.stringify(args.arguments ?? {}).slice(0, 2000),
        ok: result.ok,
        error: result.error,
      },
    });

    return result;
  },
};

// ---------------------------------------------------------------
// qualify_account — run the deep, multi-step web-research qualification loop
// (packages/agents/qualify.ts) on one account, on demand. Same loop the
// autonomous path runs; from the chat agent's view it's a single tool call.
// ---------------------------------------------------------------

const qualifyAccountTool: ToolHandler = {
  spec: {
    name: 'qualify_account',
    description:
`Run a deep, multi-step web-research qualification on ONE account. The agent searches the web, reads the pages that matter, identifies the likely buyer, and decides whether it's worth reaching out plus the single best angle — writing a sourced verdict you can audit. Returns { verdict, recommended_angle, steps, total_tokens }.

When to use: the user asks to "qualify", "dig into", "research", or "is X worth reaching out to". This actually researches the company live.
vs propose_action: propose_action only reads existing scores (instant, no research). qualify_account does real web research (slower, costs more). Use propose_action for a quick read; qualify_account when the user wants the agent to go find out.`,
    parameters: {
      type: 'object',
      properties: { entity_id: { type: 'string', description: 'The account entity id to qualify.' } },
      required: ['entity_id'],
    },
  },
  // Let runQualification default the actor to the 'qualifier' agent so the
  // verdict + facts are attributed the same way whether run from chat or the
  // autonomous trigger.
  run: async (ctx, args: { entity_id: string }) =>
    runQualification(ctx.supabase, { workspace_id: ctx.workspace_id, entity_id: args.entity_id }),
};

// ---------------------------------------------------------------
// Registry
// ---------------------------------------------------------------

export const INTAKE_TOOLS: Record<string, ToolHandler> = {
  query: queryTool,
  create_account: createAccountTool,
  enrich_contacts: enrichContactsTool,
  extract_facts: extractFactsTool,
  assert_facts: assertFactsTool,
  rescore_entity: rescoreTool,
  propose_action: proposeActionTool,
  qualify_account: qualifyAccountTool,
  trigger_drafter: triggerDrafterTool,
  composio_list_tools: composioListToolsTool,
  composio_execute: composioExecuteTool,
};

export function intakeToolSpecs(): ToolSpec[] {
  return Object.values(INTAKE_TOOLS).map((t) => t.spec);
}
