/**
 * Read-side tool implementations. These don't write events; they project current
 * state for agent consumption. All scoped to a single workspace_id.
 *
 * Designed to be token-efficient: summaries and counts, not raw row dumps.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

const STALE_DAYS = 7;
const STALE_SIGNAL_MIN = 30;
const STALE_GATE_DAYS = 7;
const STALE_DRAFT_DAYS = 7;

export type EntityStatus = 'draft_ready' | 'gated' | 'active' | 'stale' | 'no_signals';

export interface EntitySummary {
  entity_id: string;
  name: string;
  kind: string;
  status: EntityStatus;
  fact_count: number;
  signal_types: string[];
  latest_activity: string | null;
  channel_id: string | null;
  has_draft: boolean;
  top_contact: { name: string; email: string; role: string | null } | null;
  icp_fit: number | null;
}

function statusFor(latestDraftAt: string | null, latestGateAt: string | null, latestPostAt: string | null, hasSignals: boolean): EntityStatus {
  if (!hasSignals && !latestPostAt) return 'no_signals';
  const now = Date.now();
  const draftMs = latestDraftAt ? new Date(latestDraftAt).getTime() : 0;
  const gateMs = latestGateAt ? new Date(latestGateAt).getTime() : 0;
  const postMs = latestPostAt ? new Date(latestPostAt).getTime() : 0;
  if (gateMs > draftMs && gateMs > 0) return 'gated';
  if (latestDraftAt && (now - draftMs) / 86400000 < STALE_DAYS) return 'draft_ready';
  if (latestPostAt && (now - postMs) / 86400000 > STALE_DAYS) return 'stale';
  return 'active';
}

export async function listEntities(
  supabase: SupabaseClient,
  workspace_id: string,
  args: { status?: EntityStatus; signal_source?: string; limit: number; since_hours?: number; sort_by?: 'activity' | 'icp_fit' },
): Promise<EntitySummary[]> {
  const sinceCutoff = args.since_hours
    ? new Date(Date.now() - args.since_hours * 3600 * 1000).toISOString()
    : null;

  // Pull channels (one per entity that has been signal-activated)
  const ch = await supabase
    .from('channels')
    .select('id, account_entity_id, created_at')
    .eq('workspace_id', workspace_id)
    .order('created_at', { ascending: false })
    .limit(args.limit * 2);  // overshoot, filter later
  if (ch.error) throw ch.error;
  const channels = (ch.data ?? []) as Array<{ id: string; account_entity_id: string; created_at: string }>;
  if (!channels.length) return [];

  const entityIds = channels.map((c) => c.account_entity_id);
  const channelIds = channels.map((c) => c.id);

  const [entRes, draftsRes, gatesRes, postsRes, factsRes, signalsRes, contactLinksRes, typeFactsRes] = await Promise.all([
    supabase.from('entities').select('id, name').in('id', entityIds),
    supabase.from('channel_posts').select('channel_id, body, created_at')
      .in('channel_id', channelIds).eq('kind', 'touch_draft')
      .order('created_at', { ascending: false }).limit(channelIds.length * 2),
    supabase.from('channel_posts').select('channel_id, created_at')
      .in('channel_id', channelIds).eq('kind', 'gate_request')
      .order('created_at', { ascending: false }).limit(channelIds.length * 2),
    supabase.from('channel_posts').select('channel_id, created_at')
      .in('channel_id', channelIds).order('created_at', { ascending: false })
      .limit(channelIds.length * 4),
    supabase.from('facts').select('subject_entity').in('subject_entity', entityIds).is('supersedes', null),
    supabase.from('signals').select('entity_id, type, created_at').in('entity_id', entityIds)
      .order('created_at', { ascending: false }).limit(entityIds.length * 5),
    // Contacts linked to each account via works_at
    supabase.from('facts').select('subject_entity, object_entity, created_at')
      .eq('workspace_id', workspace_id).eq('predicate', 'works_at')
      .in('object_entity', entityIds).is('supersedes', null)
      .order('created_at', { ascending: false }),
    // is_a facts: type per entity
    supabase.from('facts').select('subject_entity, object_text')
      .eq('workspace_id', workspace_id).eq('predicate', 'is_a')
      .in('subject_entity', entityIds).is('supersedes', null),
  ]);

  const typeByEntity = new Map<string, string>();
  for (const r of (typeFactsRes.data ?? []) as Array<{ subject_entity: string; object_text: string | null }>) {
    if (r.object_text && !typeByEntity.has(r.subject_entity)) typeByEntity.set(r.subject_entity, r.object_text);
  }
  const entityById = new Map<string, { id: string; name: string }>();
  for (const e of (entRes.data ?? []) as Array<{ id: string; name: string }>) entityById.set(e.id, e);

  const latestDraft = new Map<string, string>();
  for (const r of (draftsRes.data ?? []) as Array<{ channel_id: string; created_at: string }>) {
    if (!latestDraft.has(r.channel_id)) latestDraft.set(r.channel_id, r.created_at);
  }

  const latestGate = new Map<string, string>();
  for (const r of (gatesRes.data ?? []) as Array<{ channel_id: string; created_at: string }>) {
    if (!latestGate.has(r.channel_id)) latestGate.set(r.channel_id, r.created_at);
  }

  const latestPost = new Map<string, string>();
  for (const r of (postsRes.data ?? []) as Array<{ channel_id: string; created_at: string }>) {
    if (!latestPost.has(r.channel_id)) latestPost.set(r.channel_id, r.created_at);
  }

  const factCount = new Map<string, number>();
  for (const r of (factsRes.data ?? []) as Array<{ subject_entity: string }>) {
    factCount.set(r.subject_entity, (factCount.get(r.subject_entity) ?? 0) + 1);
  }

  const signalTypes = new Map<string, Set<string>>();
  const signalCount = new Map<string, number>();
  for (const r of (signalsRes.data ?? []) as Array<{ entity_id: string; type: string; created_at: string }>) {
    if (!signalTypes.has(r.entity_id)) signalTypes.set(r.entity_id, new Set());
    signalTypes.get(r.entity_id)!.add(r.type);
    signalCount.set(r.entity_id, (signalCount.get(r.entity_id) ?? 0) + 1);
  }

  // Resolve top contact per account: for each account with at least one works_at link,
  // pull the contact entity's name + email + role facts. Use the most recent link.
  const accountToContactId = new Map<string, string>();
  for (const r of (contactLinksRes.data ?? []) as Array<{ subject_entity: string; object_entity: string }>) {
    if (!accountToContactId.has(r.object_entity)) accountToContactId.set(r.object_entity, r.subject_entity);
  }
  const contactIds = [...new Set(accountToContactId.values())];
  const contactById = new Map<string, { name: string; email: string; role: string | null }>();
  if (contactIds.length) {
    const [cEnts, cEmails, cRoles] = await Promise.all([
      supabase.from('entities').select('id, name').in('id', contactIds),
      supabase.from('facts').select('subject_entity, object_text')
        .eq('workspace_id', workspace_id).eq('predicate', 'email')
        .in('subject_entity', contactIds).is('supersedes', null),
      supabase.from('facts').select('subject_entity, object_text')
        .eq('workspace_id', workspace_id).eq('predicate', 'role')
        .in('subject_entity', contactIds).is('supersedes', null),
    ]);
    const nameById = new Map<string, string>();
    const emailById = new Map<string, string>();
    const roleById = new Map<string, string>();
    for (const r of (cEnts.data ?? []) as Array<{ id: string; name: string }>) nameById.set(r.id, r.name);
    for (const r of (cEmails.data ?? []) as Array<{ subject_entity: string; object_text: string }>) emailById.set(r.subject_entity, r.object_text);
    for (const r of (cRoles.data ?? []) as Array<{ subject_entity: string; object_text: string }>) roleById.set(r.subject_entity, r.object_text);
    for (const id of contactIds) {
      const email = emailById.get(id);
      if (!email) continue;
      contactById.set(id, { name: nameById.get(id) ?? (email.split('@')[0] || 'unknown'), email, role: roleById.get(id) ?? null });
    }
  }

  // Pull current icp_fit fact per entity
  const icpFacts = await supabase.from('facts').select('subject_entity, object_text')
    .eq('workspace_id', workspace_id).eq('predicate', 'icp_fit')
    .in('subject_entity', entityIds).is('supersedes', null);
  const icpByEntity = new Map<string, number>();
  for (const f of (icpFacts.data ?? []) as Array<{ subject_entity: string; object_text: string }>) {
    const v = parseFloat(f.object_text);
    if (!Number.isNaN(v)) icpByEntity.set(f.subject_entity, v);
  }

  const summaries: EntitySummary[] = channels.map((c) => {
    const ent = entityById.get(c.account_entity_id);
    const draftAt = latestDraft.get(c.id) ?? null;
    const gateAt = latestGate.get(c.id) ?? null;
    const postAt = latestPost.get(c.id) ?? null;
    const contactId = accountToContactId.get(c.account_entity_id);
    const top_contact = contactId ? (contactById.get(contactId) ?? null) : null;
    return {
      entity_id: c.account_entity_id,
      name: ent?.name ?? '(unknown)',
      kind: typeByEntity.get(c.account_entity_id) ?? 'account',
      status: statusFor(draftAt, gateAt, postAt, (signalCount.get(c.account_entity_id) ?? 0) > 0),
      fact_count: factCount.get(c.account_entity_id) ?? 0,
      signal_types: [...(signalTypes.get(c.account_entity_id) ?? new Set<string>())].sort(),
      latest_activity: postAt,
      channel_id: c.id,
      has_draft: !!draftAt,
      top_contact,
      icp_fit: icpByEntity.get(c.account_entity_id) ?? null,
    };
  });

  let filtered = summaries;
  if (args.status) filtered = filtered.filter((s) => s.status === args.status);
  if (args.signal_source) filtered = filtered.filter((s) => s.signal_types.includes(args.signal_source!));
  if (sinceCutoff) filtered = filtered.filter((s) => !s.latest_activity || s.latest_activity > sinceCutoff);

  if (args.sort_by === 'icp_fit') {
    filtered.sort((a, b) => (b.icp_fit ?? -1) - (a.icp_fit ?? -1));
  } else {
    filtered.sort((a, b) => {
      const at = a.latest_activity ?? '0';
      const bt = b.latest_activity ?? '0';
      return bt.localeCompare(at);
    });
  }

  return filtered.slice(0, args.limit);
}

export interface EntityProjection {
  entity: { id: string; name: string; kind: string; attributes: Record<string, unknown> };
  facts: Array<{ id: string; predicate: string; object: string | null; observed_at: string; confidence: number }>;
  signals: Array<{ id: string; type: string; magnitude: number; observed_at: string; body: string }>;
  posts: Array<{ id: string; kind: string; body: string; created_at: string; author: string }>;
  channel_id: string | null;
}

export async function getEntity(
  supabase: SupabaseClient,
  workspace_id: string,
  entity_id: string,
): Promise<EntityProjection> {
  const [entRes, factsRes, sigsRes, channelRes] = await Promise.all([
    supabase.from('entities').select('id, name, attributes')
      .eq('workspace_id', workspace_id).eq('id', entity_id).single(),
    // Fetch all facts (incl. superseded) so we can pick the CURRENT ones.
    // supersede_fact writes the new row with supersedes = <old id>, so the
    // current fact is the one NOT pointed at by any other row's supersedes —
    // `supersedes is null` returns the stale original. (Same convention used by
    // relations.ts / feed / replay / cite.)
    supabase.from('facts').select('id, predicate, object_text, observed_at, confidence, supersedes')
      .eq('workspace_id', workspace_id).eq('subject_entity', entity_id)
      .order('observed_at', { ascending: false }).limit(500),
    supabase.from('signals').select('id, type, magnitude, observed_at, body_for_embedding')
      .eq('workspace_id', workspace_id).eq('entity_id', entity_id)
      .order('observed_at', { ascending: false }).limit(20),
    supabase.from('channels').select('id').eq('workspace_id', workspace_id).eq('account_entity_id', entity_id).maybeSingle(),
  ]);

  if (entRes.error || !entRes.data) throw new Error(`entity not found: ${entRes.error?.message}`);
  const baseEntity = entRes.data as { id: string; name: string; attributes: Record<string, unknown> };

  // Current facts = those not superseded by any other fetched row.
  const allFactRows = (factsRes.data ?? []) as Array<{ id: string; predicate: string; object_text: string | null; observed_at: string; confidence: number; supersedes: string | null }>;
  const supersededIds = new Set(allFactRows.map((f) => f.supersedes).filter((x): x is string => !!x));
  const currentFactRows = allFactRows.filter((f) => !supersededIds.has(f.id)).slice(0, 50);

  // Derive `kind` from the current is_a fact (no extra query).
  const isAFacts = currentFactRows.filter((f) => f.predicate === 'is_a' && f.object_text);
  const entityKind = (isAFacts[0]?.object_text as string | undefined) ?? 'entity';
  const entity = { ...baseEntity, kind: entityKind };

  let posts: EntityProjection['posts'] = [];
  const channel_id = (channelRes.data?.id as string | undefined) ?? null;
  if (channel_id) {
    const postsRes = await supabase.from('channel_posts')
      .select('id, kind, body, created_at, author_id')
      .eq('channel_id', channel_id)
      .order('created_at', { ascending: false }).limit(30);
    posts = ((postsRes.data ?? []) as Array<{ id: string; kind: string; body: string; created_at: string; author_id: string }>).map((p) => ({
      id: p.id, kind: p.kind, body: p.body, created_at: p.created_at, author: p.author_id,
    }));
  }

  return {
    entity,
    facts: currentFactRows.map((f) => ({
      id: f.id, predicate: f.predicate, object: f.object_text, observed_at: f.observed_at, confidence: f.confidence,
    })),
    signals: ((sigsRes.data ?? []) as Array<{ id: string; type: string; magnitude: number; observed_at: string; body_for_embedding: string }>).map((s) => ({
      id: s.id, type: s.type, magnitude: s.magnitude, observed_at: s.observed_at, body: s.body_for_embedding,
    })),
    posts,
    channel_id,
  };
}

export interface OutreachStateResult {
  status: EntityStatus;
  has_draft: boolean;
  draft?: { body: string; created_at: string; cites: string[] };
  gated: boolean;
  gate?: { policy: string; created_at: string };
  last_activity: string | null;
  fact_count: number;
}

export async function outreachState(
  supabase: SupabaseClient,
  workspace_id: string,
  entity_id: string,
): Promise<OutreachStateResult> {
  const channelRes = await supabase.from('channels').select('id')
    .eq('workspace_id', workspace_id).eq('account_entity_id', entity_id).maybeSingle();
  const channel_id = channelRes.data?.id as string | undefined;

  const [factsRes, sigsRes] = await Promise.all([
    supabase.from('facts').select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspace_id).eq('subject_entity', entity_id).is('supersedes', null),
    supabase.from('signals').select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspace_id).eq('entity_id', entity_id),
  ]);

  if (!channel_id) {
    return {
      status: (sigsRes.count ?? 0) > 0 ? 'active' : 'no_signals',
      has_draft: false,
      gated: false,
      last_activity: null,
      fact_count: factsRes.count ?? 0,
    };
  }

  const [draftRes, gateRes, lastRes] = await Promise.all([
    supabase.from('channel_posts').select('body, created_at, cites')
      .eq('channel_id', channel_id).eq('kind', 'touch_draft')
      .order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('channel_posts').select('body, created_at')
      .eq('channel_id', channel_id).eq('kind', 'gate_request')
      .order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('channel_posts').select('created_at')
      .eq('channel_id', channel_id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ]);

  const draftAt = draftRes.data?.created_at as string | undefined;
  const gateAt = gateRes.data?.created_at as string | undefined;
  const lastAt = lastRes.data?.created_at as string | undefined;
  const gated = !!gateAt && (!draftAt || gateAt > draftAt);

  return {
    status: statusFor(draftAt ?? null, gateAt ?? null, lastAt ?? null, (sigsRes.count ?? 0) > 0),
    has_draft: !!draftAt,
    draft: draftAt ? {
      body: draftRes.data!.body as string,
      created_at: draftAt,
      cites: ((draftRes.data!.cites as string[] | null) ?? []),
    } : undefined,
    gated,
    gate: gateAt ? {
      policy: ((gateRes.data!.body as string).split('\n')[0] ?? '').slice(0, 200),
      created_at: gateAt,
    } : undefined,
    last_activity: lastAt ?? null,
    fact_count: factsRes.count ?? 0,
  };
}

export interface EntityMatch {
  entity_id: string;
  name: string;
  kind: string;
  score: number;
}

export async function lookupEntity(
  supabase: SupabaseClient,
  workspace_id: string,
  args: { name: string; fuzzy: boolean; limit: number },
): Promise<EntityMatch[]> {
  const q = args.name.trim();
  if (!q) return [];
  // gin_trgm index on entities.name supports both exact and ILIKE; use ILIKE
  // with leading/trailing wildcards for fuzzy matching.
  const pattern = args.fuzzy ? `%${q}%` : q;
  const { data, error } = args.fuzzy
    ? await supabase.from('entities').select('id, name')
        .eq('workspace_id', workspace_id).is('archived_at', null).ilike('name', pattern).limit(args.limit)
    : await supabase.from('entities').select('id, name')
        .eq('workspace_id', workspace_id).is('archived_at', null).eq('name', q).limit(args.limit);
  if (error) throw error;
  const rows = ((data ?? []) as Array<{ id: string; name: string }>);
  // Look up is_a facts for the matched ids in one batch.
  const idArr = rows.map((r) => r.id);
  const typeById = new Map<string, string>();
  if (idArr.length) {
    const { data: tf } = await supabase.from('facts').select('subject_entity, object_text')
      .eq('workspace_id', workspace_id).eq('predicate', 'is_a').is('supersedes', null)
      .in('subject_entity', idArr);
    for (const f of (tf ?? []) as Array<{ subject_entity: string; object_text: string | null }>) {
      if (f.object_text && !typeById.has(f.subject_entity)) typeById.set(f.subject_entity, f.object_text);
    }
  }
  const lc = q.toLowerCase();
  return rows.map((r) => ({
    entity_id: r.id,
    name: r.name,
    kind: typeById.get(r.id) ?? 'entity',
    score: r.name.toLowerCase() === lc ? 1.0 : 1.0 - Math.abs(r.name.length - q.length) / Math.max(r.name.length, q.length, 1),
  })).sort((a, b) => b.score - a.score);
}

export interface SimilarEntity {
  entity_id: string;
  name: string;
  kind: string;
  similarity: number;
}

export async function findSimilarEntities(
  supabase: SupabaseClient,
  workspace_id: string,
  args: { entity_id: string; top_k: number; perspective?: string },
): Promise<SimilarEntity[]> {
  const { data, error } = await supabase.rpc('find_similar_entities', {
    p_workspace_id: workspace_id,
    p_entity_id: args.entity_id,
    p_top_k: args.top_k,
    p_perspective: args.perspective ?? null,
  });
  if (error) {
    if (error.code === 'PGRST202' || error.code === '42883') {
      throw new Error('find_similar_entities RPC not found. Apply migration 0016_find_similar_entities.sql.');
    }
    throw error;
  }
  return ((data ?? []) as Array<{ entity_id: string; name: string; kind: string; similarity: number }>);
}

export interface TokenSummary {
  since_hours: number;
  runs: number;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  by_model: Array<{ model: string; runs: number; input: number; output: number; cached: number }>;
  by_behavior: Array<{ behavior: string; runs: number; input: number; output: number }>;
}

/**
 * Aggregate token usage across recent agent runs. Reads from the
 * agent_run_metrics events emitted by agent_logic.ts after every LLM call.
 * No pricing — raw token counts only. Convert to cost externally if needed.
 */
export async function tokenSummary(
  supabase: SupabaseClient,
  workspace_id: string,
  args: { since_hours: number },
): Promise<TokenSummary> {
  const since = new Date(Date.now() - args.since_hours * 3600 * 1000).toISOString();
  const { data, error } = await supabase.from('events').select('payload')
    .eq('workspace_id', workspace_id).eq('action', 'agent_run_metrics')
    .gte('created_at', since).limit(5000);
  if (error) throw error;

  let runs = 0; let input = 0; let output = 0; let cached = 0;
  const byModel = new Map<string, { runs: number; input: number; output: number; cached: number }>();
  const byBehavior = new Map<string, { runs: number; input: number; output: number }>();

  for (const e of (data ?? []) as Array<{ payload: { model?: string; behavior?: string; input_tokens?: number; output_tokens?: number; cached_input_tokens?: number } | null }>) {
    const p = e.payload ?? {};
    runs++;
    input += p.input_tokens ?? 0;
    output += p.output_tokens ?? 0;
    cached += p.cached_input_tokens ?? 0;
    const m = p.model ?? 'unknown';
    const mAgg = byModel.get(m) ?? { runs: 0, input: 0, output: 0, cached: 0 };
    mAgg.runs++; mAgg.input += p.input_tokens ?? 0; mAgg.output += p.output_tokens ?? 0; mAgg.cached += p.cached_input_tokens ?? 0;
    byModel.set(m, mAgg);
    const b = p.behavior ?? 'unknown';
    const bAgg = byBehavior.get(b) ?? { runs: 0, input: 0, output: 0 };
    bAgg.runs++; bAgg.input += p.input_tokens ?? 0; bAgg.output += p.output_tokens ?? 0;
    byBehavior.set(b, bAgg);
  }

  return {
    since_hours: args.since_hours,
    runs, input_tokens: input, output_tokens: output, cached_input_tokens: cached,
    by_model: [...byModel.entries()].map(([model, v]) => ({ model, ...v })).sort((a, b) => b.runs - a.runs),
    by_behavior: [...byBehavior.entries()].map(([behavior, v]) => ({ behavior, ...v })).sort((a, b) => b.runs - a.runs),
  };
}

export interface PastOutcome {
  entity_id: string;
  entity_name: string;
  gate_id: string;
  gate_policy: string;
  decision: 'approve' | 'reject' | 'modify';
  decided_at: string;
  draft_excerpt: string | null;
  similarity: number | null;  // null when looked up by entity_id, set when via semantic neighbor
}

/**
 * Returns recent gate outcomes (decisions) for entities related to the given query.
 * Three lookup modes (combine via OR):
 *   1. Same entity (entity_id)
 *   2. Semantically similar entities (entity_id + semantic_neighbors=true)
 *   3. Same signal_type (signal_type filter)
 * Used by the drafter user-prompt builder to give agents memory of "what happened
 * last time we drafted to companies like this."
 */
export async function pastOutcomes(
  supabase: SupabaseClient,
  workspace_id: string,
  args: { entity_id?: string; signal_type?: string; semantic_neighbors: boolean; limit: number; since_days: number },
): Promise<PastOutcome[]> {
  const cutoff = new Date(Date.now() - args.since_days * 86400000).toISOString();

  // Build candidate entity set
  const candidateIds = new Set<string>();
  const similarityById = new Map<string, number>();

  if (args.entity_id) {
    candidateIds.add(args.entity_id);
    if (args.semantic_neighbors) {
      const { data, error } = await supabase.rpc('find_similar_entities', {
        p_workspace_id: workspace_id,
        p_entity_id: args.entity_id,
        p_top_k: 12,
        p_perspective: null,
      });
      if (!error) {
        for (const r of (data ?? []) as Array<{ entity_id: string; similarity: number }>) {
          candidateIds.add(r.entity_id);
          similarityById.set(r.entity_id, r.similarity);
        }
      }
    }
  }

  if (args.signal_type) {
    const sigs = await supabase.from('signals').select('entity_id')
      .eq('workspace_id', workspace_id).eq('type', args.signal_type)
      .gte('created_at', cutoff).limit(200);
    for (const s of (sigs.data ?? []) as Array<{ entity_id: string }>) candidateIds.add(s.entity_id);
  }

  if (!candidateIds.size) return [];

  // Find channels for those entities
  const channels = await supabase.from('channels').select('id, account_entity_id')
    .eq('workspace_id', workspace_id).in('account_entity_id', [...candidateIds]);
  const channelToEntity = new Map<string, string>();
  for (const c of (channels.data ?? []) as Array<{ id: string; account_entity_id: string }>) {
    channelToEntity.set(c.id, c.account_entity_id);
  }
  if (!channelToEntity.size) return [];

  // Pull gates joined to channel_posts + entities, decided in window
  const gatePosts = await supabase.from('channel_posts').select('id, channel_id, body')
    .in('channel_id', [...channelToEntity.keys()]).eq('kind', 'gate_request');
  const postIdToChannel = new Map<string, { channel_id: string; body: string }>();
  for (const p of (gatePosts.data ?? []) as Array<{ id: string; channel_id: string; body: string }>) {
    postIdToChannel.set(p.id, { channel_id: p.channel_id, body: p.body });
  }
  if (!postIdToChannel.size) return [];

  const gates = await supabase.from('gates')
    .select('id, channel_post_id, policy, decision, decided_at')
    .eq('workspace_id', workspace_id)
    .in('channel_post_id', [...postIdToChannel.keys()])
    .not('decided_at', 'is', null)
    .gte('decided_at', cutoff)
    .order('decided_at', { ascending: false })
    .limit(args.limit * 2);

  const entitiesById = new Map<string, string>();
  const ents = await supabase.from('entities').select('id, name').in('id', [...candidateIds]);
  for (const e of (ents.data ?? []) as Array<{ id: string; name: string }>) entitiesById.set(e.id, e.name);

  const outcomes: PastOutcome[] = [];
  for (const g of (gates.data ?? []) as Array<{ id: string; channel_post_id: string; policy: string; decision: 'approve' | 'reject' | 'modify'; decided_at: string }>) {
    const post = postIdToChannel.get(g.channel_post_id);
    if (!post) continue;
    const entityId = channelToEntity.get(post.channel_id);
    if (!entityId) continue;
    const entityName = entitiesById.get(entityId) ?? '(unknown)';
    outcomes.push({
      entity_id: entityId,
      entity_name: entityName,
      gate_id: g.id,
      gate_policy: g.policy,
      decision: g.decision,
      decided_at: g.decided_at,
      draft_excerpt: post.body.slice(0, 120),
      similarity: similarityById.get(entityId) ?? null,
    });
  }

  return outcomes.slice(0, args.limit);
}

export interface HealthCheckResult {
  unmatched_signals: number;
  errored_sources: number;
  stale_gates: number;
  stale_drafts: number;
  ts: string;
}

export async function healthCheck(supabase: SupabaseClient, workspace_id: string): Promise<HealthCheckResult> {
  // 1. unmatched signals
  const sigCutoff = new Date(Date.now() - STALE_SIGNAL_MIN * 60 * 1000).toISOString();
  const sigs = await supabase.from('signals').select('id').eq('workspace_id', workspace_id).lt('created_at', sigCutoff).limit(500);
  const sigIds = ((sigs.data ?? []) as Array<{ id: string }>).map((r) => r.id);
  let unmatched = 0;
  if (sigIds.length) {
    // Scope to the candidate signals (target_id IS the signal_id). The old
    // unbounded select capped at PostgREST's 1000-row default, so once a
    // workspace had >1000 markers this overcounted unmatched_signals, which
    // tripped systemHealthMonitor into opening phantom gates every hour.
    const matched = await supabase.from('events').select('target_id')
      .eq('workspace_id', workspace_id).eq('action', 'subscription.matched')
      .in('target_id', sigIds);
    const matchedSet = new Set<string>(
      ((matched.data ?? []) as Array<{ target_id: string | null }>)
        .map((e) => e.target_id)
        .filter((id): id is string => Boolean(id)),
    );
    unmatched = sigIds.filter((id) => !matchedSet.has(id)).length;
  }

  // 2. errored sources
  const errSrc = await supabase.from('sources').select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspace_id).eq('last_run_status', 'error');
  const erroredSources = errSrc.count ?? 0;

  // 3. stale open gates
  const gateCutoff = new Date(Date.now() - STALE_GATE_DAYS * 86400000).toISOString();
  const gateReqs = await supabase.from('events').select('id')
    .eq('workspace_id', workspace_id).eq('action', 'request_gate').lt('created_at', gateCutoff).limit(200);
  const gateIds = new Set<number>(((gateReqs.data ?? []) as Array<{ id: number }>).map((g) => g.id));
  let staleGates = 0;
  if (gateIds.size) {
    const decided = await supabase.from('events').select('parent_event_id')
      .eq('workspace_id', workspace_id).eq('action', 'gate_decision');
    const decidedSet = new Set<number>();
    for (const d of (decided.data ?? []) as Array<{ parent_event_id: number | null }>) {
      if (d.parent_event_id) decidedSet.add(d.parent_event_id);
    }
    for (const gid of gateIds) if (!decidedSet.has(gid)) staleGates++;
  }

  // 4. stale drafts
  const draftCutoff = new Date(Date.now() - STALE_DRAFT_DAYS * 86400000).toISOString();
  const drafts = await supabase.from('channel_posts').select('id, channel_id')
    .eq('kind', 'touch_draft').lt('created_at', draftCutoff).limit(200);
  const draftRows = (drafts.data ?? []) as Array<{ id: string; channel_id: string }>;
  let staleDrafts = 0;
  if (draftRows.length) {
    const channelIds = [...new Set(draftRows.map((d) => d.channel_id))];
    const followups = await supabase.from('channel_posts').select('channel_id')
      .in('channel_id', channelIds).gt('created_at', draftCutoff);
    const channelsWithFollow = new Set<string>(((followups.data ?? []) as Array<{ channel_id: string }>).map((p) => p.channel_id));
    staleDrafts = draftRows.filter((d) => !channelsWithFollow.has(d.channel_id)).length;
  }

  return {
    unmatched_signals: unmatched,
    errored_sources: erroredSources,
    stale_gates: staleGates,
    stale_drafts: staleDrafts,
    ts: new Date().toISOString(),
  };
}
