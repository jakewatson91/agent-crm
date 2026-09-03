import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { pickSourceUrl, type StructuredTags } from '../../_lib/source_url';
import { SCORE_DIMS } from '@agent-crm/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Replay summary — what a human actually wants to see when they ask
 * "what did the system look like at this moment in time?" Returns:
 *   - Headline counts (entities / active facts / signals / posts / gates)
 *   - Top 5 recent signals with their body text so you can read what came in
 *   - Top recent posts (claims + drafts + decisions) with body
 *   - Newest 5 entities at the cutoff
 *
 * Joins back to the live signals + channel_posts + entities tables to fetch
 * body_for_embedding / body / name that the raw replay_to RPC doesn't carry.
 */
export async function GET(req: NextRequest) {
  const ws = req.nextUrl.searchParams.get('workspace_id');
  const ts = req.nextUrl.searchParams.get('ts');
  if (!ws || !ts) return NextResponse.json({ error: 'workspace_id and ts required' }, { status: 400 });

  const sb = createServerClient();
  const { data: snap, error } = await sb.rpc('replay_to', { p_workspace_id: ws, p_ts: ts });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  type Snapshot = {
    entities?: Array<{ id: string; name: string; kind: string; attributes: Record<string, unknown>; created_at: string }>;
    facts?: Array<{ id: string; predicate: string; object_text: string; subject_entity: string; observed_at: string; supersedes?: string | null }>;
    signals?: Array<{ id: string; entity_id: string; type: string; magnitude: number; structured_tags: Record<string, unknown>; observed_at: string }>;
    channel_posts?: Array<{ id: string; channel_id: string; kind: string; created_at: string }>;
    gates?: Array<{ id: string; policy: string; decided_at?: string | null; requested_at: string }>;
  };
  const s = (snap ?? {}) as Snapshot;
  const entities = s.entities ?? [];
  const facts = s.facts ?? [];
  const signals = s.signals ?? [];
  const posts = s.channel_posts ?? [];
  const gates = s.gates ?? [];

  // Active facts = facts not referenced as `supersedes` by any later fact in this snapshot.
  const supersededIds = new Set<string>(facts.map((f) => f.supersedes ?? null).filter((x): x is string => !!x));
  const activeFacts = facts.filter((f) => !supersededIds.has(f.id));

  // Entity name lookup for joining.
  const entityNameById = new Map<string, string>();
  for (const e of entities) entityNameById.set(e.id, e.name);

  // ---- Top 5 most recent signals, joined with body_for_embedding -------
  const sortedSignals = [...signals].sort((a, b) => (b.observed_at ?? '').localeCompare(a.observed_at ?? ''));
  const topSignalIds = sortedSignals.slice(0, 5).map((sig) => sig.id);
  const sigBodies = new Map<string, string>();
  if (topSignalIds.length) {
    const r = await sb.from('signals')
      .select('id, body_for_embedding')
      .in('id', topSignalIds);
    for (const row of (r.data ?? []) as Array<{ id: string; body_for_embedding: string | null }>) {
      if (row.body_for_embedding) sigBodies.set(row.id, row.body_for_embedding);
    }
  }
  const topSignals = sortedSignals.slice(0, 5).map((sig) => {
    const tags = (sig.structured_tags ?? {}) as StructuredTags;
    return {
      id: sig.id,
      type: sig.type,
      magnitude: sig.magnitude,
      entity_id: sig.entity_id,
      entity_name: entityNameById.get(sig.entity_id) ?? '(unknown entity)',
      source: tags.signal_source ?? null,
      url: pickSourceUrl(tags),
      observed_at: sig.observed_at,
      body: sigBodies.get(sig.id) ?? '',
    };
  });

  // ---- Top 5 recent posts, joined with body + entity name -------------
  const sortedPosts = [...posts].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
  const topPostIds = sortedPosts.slice(0, 8).map((p) => p.id);
  const postRows = topPostIds.length
    ? await sb.from('channel_posts')
        .select('id, body, cites, cite_quotes, parent_post_id, kind, channel_id, channels!inner(account_entity_id)')
        .in('id', topPostIds)
    : { data: [] as Array<{ id: string; body: string; cites: string[] | null; cite_quotes: { fact_id: string; quote: string }[] | null; parent_post_id: string | null; kind: string; channel_id: string; channels: { account_entity_id: string } }> };
  type PostRow = { id: string; body: string; cites: string[] | null; cite_quotes: { fact_id: string; quote: string }[] | null; parent_post_id: string | null; kind: string; channel_id: string; channels: { account_entity_id: string } };
  const postRowsTyped = (postRows.data ?? []) as unknown as PostRow[];
  const postById = new Map<string, PostRow>();
  for (const r of postRowsTyped) postById.set(r.id, r);
  // A `decision` child post is the plain-language reasoning for its parent
  // (same parent-collapse convention as feed_items.ts) - resolve it here so
  // the page can render it next to the parent's cited facts.
  const reasoningByParent = new Map<string, string>();
  for (const r of postRowsTyped) {
    if (r.parent_post_id && r.kind === 'decision') reasoningByParent.set(r.parent_post_id, r.body);
  }
  const topPosts = sortedPosts.slice(0, 8).map((p) => {
    const row = postById.get(p.id);
    const entId = row?.channels?.account_entity_id;
    return {
      id: p.id,
      kind: p.kind,
      created_at: p.created_at,
      body: row?.body ?? '',
      cites: row?.cites ?? [],
      cite_quotes: row?.cite_quotes ?? [],
      reasoning: reasoningByParent.get(p.id) ?? null,
      entity_id: entId ?? null,
      entity_name: entId ? entityNameById.get(entId) ?? '(unknown)' : '(unknown)',
    };
  });

  // ---- Newest 5 entities at cutoff, with score breakdown --------------
  const newestSlice = [...entities]
    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
    .slice(0, 5);
  const newestIds = newestSlice.map((e) => e.id);

  // Score rows + the breakdown JSON for these entities, latest-wins.
  //
  // The six dimensions are read off icp_fit_breakdown, not off a row each.
  // Four of them (industry_match, stage_match, recency, graph_proximity) have
  // no row of their own any more — 7fd71bc stopped writing a duplicate per
  // dimension per pass, since the JSON already held the number. Reading rows
  // here would have quietly dropped four of the seven lines this block draws.
  // score_total keeps its own row (the breakdown holds dimensions, not the
  // total), so its trace still points at the fact that recorded it.
  type ScoreFact = { subject_entity: string; predicate: string; object_text: string; id: string; supersedes: string | null };
  const scoreFacts = newestIds.length
    ? await sb.from('facts')
        .select('subject_entity, predicate, object_text, id, supersedes')
        .eq('workspace_id', ws)
        .in('subject_entity', newestIds)
        .or('predicate.like.score_%,predicate.eq.icp_fit_breakdown')
        .order('observed_at', { ascending: false })
    : { data: [] as ScoreFact[] };
  const scoreFactsTyped = (scoreFacts.data ?? []) as ScoreFact[];
  // Active facts only (not in any other fact's `supersedes`).
  const supersededFactIds = new Set<string>(scoreFactsTyped.map((f) => f.supersedes).filter((x): x is string => !!x));
  const activeScoreFacts = scoreFactsTyped.filter((f) => !supersededFactIds.has(f.id));

  const scoresByEntity = new Map<string, Record<string, { value: number; fact_id: string }>>();
  const put = (entity: string, predicate: string, value: number, fact_id: string) => {
    if (!Number.isFinite(value)) return;
    if (!scoresByEntity.has(entity)) scoresByEntity.set(entity, {});
    scoresByEntity.get(entity)![predicate] = { value, fact_id };
  };
  for (const f of activeScoreFacts) {
    if (f.predicate === 'icp_fit_breakdown') continue;
    put(f.subject_entity, f.predicate, parseFloat(f.object_text), f.id);
  }
  // Dimensions from the breakdown win over any surviving row of the same name:
  // it is written on every pass, so it is never the staler of the two.
  for (const f of activeScoreFacts) {
    if (f.predicate !== 'icp_fit_breakdown') continue;
    let dims: Record<string, unknown>;
    try { dims = JSON.parse(f.object_text) as Record<string, unknown>; } catch { continue; }
    for (const dim of SCORE_DIMS) {
      const v = dims[dim];
      if (typeof v === 'number') put(f.subject_entity, `score_${dim}`, v, f.id);
    }
  }

  const newestEntities = newestSlice.map((e) => ({
    id: e.id,
    name: e.name,
    kind: e.kind,
    domain: (e.attributes as { domain?: string } | null)?.domain ?? null,
    created_at: e.created_at,
    scores: scoresByEntity.get(e.id) ?? {},
  }));

  // Open gates at cutoff (decided_at null or after cutoff).
  const cutoffMs = Date.parse(ts);
  const openGates = gates.filter((g) => !g.decided_at || Date.parse(g.decided_at) > cutoffMs);

  return NextResponse.json({
    ts,
    counts: {
      entities: entities.length,
      active_facts: activeFacts.length,
      total_facts: facts.length,
      signals: signals.length,
      posts: posts.length,
      gates_total: gates.length,
      gates_open: openGates.length,
    },
    top_signals: topSignals,
    top_posts: topPosts,
    newest_entities: newestEntities,
  });
}
