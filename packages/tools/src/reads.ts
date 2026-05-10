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
  args: { status?: EntityStatus; signal_source?: string; limit: number; since_hours?: number },
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

  const [entRes, draftsRes, gatesRes, postsRes, factsRes, signalsRes] = await Promise.all([
    supabase.from('entities').select('id, name, kind').in('id', entityIds),
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
  ]);

  const entityById = new Map<string, { id: string; name: string; kind: string }>();
  for (const e of (entRes.data ?? []) as Array<{ id: string; name: string; kind: string }>) entityById.set(e.id, e);

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

  const summaries: EntitySummary[] = channels.map((c) => {
    const ent = entityById.get(c.account_entity_id);
    const draftAt = latestDraft.get(c.id) ?? null;
    const gateAt = latestGate.get(c.id) ?? null;
    const postAt = latestPost.get(c.id) ?? null;
    return {
      entity_id: c.account_entity_id,
      name: ent?.name ?? '(unknown)',
      kind: ent?.kind ?? 'account',
      status: statusFor(draftAt, gateAt, postAt, (signalCount.get(c.account_entity_id) ?? 0) > 0),
      fact_count: factCount.get(c.account_entity_id) ?? 0,
      signal_types: [...(signalTypes.get(c.account_entity_id) ?? new Set<string>())].sort(),
      latest_activity: postAt,
      channel_id: c.id,
      has_draft: !!draftAt,
    };
  });

  let filtered = summaries;
  if (args.status) filtered = filtered.filter((s) => s.status === args.status);
  if (args.signal_source) filtered = filtered.filter((s) => s.signal_types.includes(args.signal_source!));
  if (sinceCutoff) filtered = filtered.filter((s) => !s.latest_activity || s.latest_activity > sinceCutoff);

  filtered.sort((a, b) => {
    const at = a.latest_activity ?? '0';
    const bt = b.latest_activity ?? '0';
    return bt.localeCompare(at);
  });

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
    supabase.from('entities').select('id, name, kind, attributes')
      .eq('workspace_id', workspace_id).eq('id', entity_id).single(),
    supabase.from('facts').select('id, predicate, object_text, observed_at, confidence')
      .eq('workspace_id', workspace_id).eq('subject_entity', entity_id).is('supersedes', null)
      .order('observed_at', { ascending: false }).limit(50),
    supabase.from('signals').select('id, type, magnitude, observed_at, body_for_embedding')
      .eq('workspace_id', workspace_id).eq('entity_id', entity_id)
      .order('observed_at', { ascending: false }).limit(20),
    supabase.from('channels').select('id').eq('workspace_id', workspace_id).eq('account_entity_id', entity_id).maybeSingle(),
  ]);

  if (entRes.error || !entRes.data) throw new Error(`entity not found: ${entRes.error?.message}`);
  const entity = entRes.data as { id: string; name: string; kind: string; attributes: Record<string, unknown> };

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
    facts: ((factsRes.data ?? []) as Array<{ id: string; predicate: string; object_text: string | null; observed_at: string; confidence: number }>).map((f) => ({
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
    const matched = await supabase.from('events').select('payload')
      .eq('workspace_id', workspace_id).eq('action', 'subscription.matched');
    const matchedSet = new Set<string>();
    for (const e of (matched.data ?? []) as Array<{ payload: { signal_id?: string } | null }>) {
      const sid = e.payload?.signal_id;
      if (sid) matchedSet.add(sid);
    }
    unmatched = sigIds.filter((id) => !matchedSet.has(id)).length;
  }

  // 2. errored sources
  const errSrc = await supabase.from('sources').select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspace_id).eq('last_run_status', 'error');
  const erroredSources = errSrc.count ?? 0;

  // 3. stale open gates
  const gateCutoff = new Date(Date.now() - STALE_GATE_DAYS * 86400000).toISOString();
  const gateReqs = await supabase.from('events').select('id')
    .eq('workspace_id', workspace_id).eq('action', 'request_gate').lt('ts', gateCutoff).limit(200);
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
