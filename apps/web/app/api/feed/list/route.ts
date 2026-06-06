/**
 * Per-workspace feed: the last ~400 channel posts, parent-collapsed and 14d-deduped,
 * pre-aggregated for the /workspace/[ws]/feed page.
 */
import { NextResponse } from 'next/server';
import { unstable_cache } from 'next/cache';
import { createServerClient } from '@agent-crm/db';

export const runtime = 'nodejs';

interface FeedItem {
  id: string;
  channel_id: string;
  channel_title: string;
  entity_id: string;
  entity_name: string;
  kind: 'claim' | 'decision' | 'touch_draft' | 'gate_request' | 'system' | 'outcome' | 'question';
  body: string;
  cites: string[];
  author_kind: string;
  author_id: string;
  created_at: string;
  icp_fit: number | null;
  reasoning: string | null;
  dup_count: number;
}

const _getFeedItems = async (ws: string): Promise<FeedItem[]> => {
  const supabase = createServerClient();

  // Fire posts (with entity name joined) + icp_fit facts in parallel.
  // Facts is scoped to the workspace's icp_fit rows — typically O(entities), not large.
  const [postsRes, fitsRes] = await Promise.all([
    supabase
      .from('channel_posts')
      .select(`
        id, kind, body, cites, author_kind, author_id, created_at, parent_post_id,
        channels!inner(id, title, workspace_id, account_entity_id,
          entity:entities(id, name)
        )
      `)
      .eq('channels.workspace_id', ws)
      .order('created_at', { ascending: false })
      .limit(400),
    supabase
      .from('facts')
      .select('subject_entity, object_text, supersedes, id')
      .eq('workspace_id', ws)
      .eq('predicate', 'icp_fit'),
  ]);

  const rows = (postsRes.data ?? []) as unknown as Array<{
    id: string; kind: string; body: string; cites: string[];
    author_kind: string; author_id: string; created_at: string;
    parent_post_id: string | null;
    channels: {
      id: string; title: string; account_entity_id: string;
      entity: { id: string; name: string } | null;
    };
  }>;

  const entMap = new Map<string, string>();
  for (const r of rows) {
    const ent = r.channels.entity;
    if (ent && !entMap.has(ent.id)) entMap.set(ent.id, ent.name);
  }

  const icpMap = new Map<string, number>();
  const superseded = new Set<string>(((fitsRes.data ?? []) as any[]).map((f) => f.supersedes).filter(Boolean));
  for (const f of (fitsRes.data ?? []) as any[]) {
    if (superseded.has(f.id)) continue;
    const v = parseFloat(f.object_text);
    if (!isNaN(v) && !icpMap.has(f.subject_entity)) icpMap.set(f.subject_entity, v);
  }

  // Parent-collapse: a `decision` child of a `touch_draft`/`claim` becomes the
  // parent's `reasoning`, and the child drops as a top-level row.
  const childrenByParent = new Map<string, { body: string }>();
  for (const r of rows) {
    if (r.parent_post_id && r.kind === 'decision') {
      childrenByParent.set(r.parent_post_id, { body: r.body });
    }
  }
  const childIds = new Set(
    rows.filter((r) => r.parent_post_id && r.kind === 'decision').map((r) => r.id),
  );

  const baseItems: FeedItem[] = rows
    .filter((r) => !childIds.has(r.id))
    .map((r) => ({
      id: r.id,
      channel_id: r.channels.id,
      channel_title: r.channels.title,
      entity_id: r.channels.account_entity_id,
      entity_name: entMap.get(r.channels.account_entity_id) ?? r.channels.title,
      kind: r.kind as FeedItem['kind'],
      body: r.body,
      cites: Array.isArray(r.cites) ? r.cites : [],
      author_kind: r.author_kind,
      author_id: r.author_id,
      created_at: r.created_at,
      icp_fit: icpMap.get(r.channels.account_entity_id) ?? null,
      reasoning: childrenByParent.get(r.id)?.body ?? null,
      dup_count: 1,
    }));

  // Dedup within 14d: identical (entity, kind, cite-set) collapse into one row.
  const DEDUP_WINDOW_MS = 14 * 86400 * 1000;
  const now = Date.now();
  const dedupKey = (it: FeedItem) =>
    `${it.entity_id}::${it.kind}::${[...it.cites].sort().join(',')}`;
  const grouped = new Map<string, FeedItem>();
  for (const it of baseItems) {
    const recent = now - Date.parse(it.created_at) <= DEDUP_WINDOW_MS;
    if (!recent) { grouped.set(it.id, it); continue; }
    const k = dedupKey(it);
    const prev = grouped.get(k);
    if (!prev) grouped.set(k, it);
    else prev.dup_count += 1;
  }
  return [...grouped.values()].sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
  );
};

const getFeedItems = unstable_cache(
  _getFeedItems,
  ['feed-items'],
  { revalidate: 20, tags: ['feed'] },
);

export async function GET(req: Request) {
  const url = new URL(req.url);
  const ws = url.searchParams.get('workspace_id');
  if (!ws) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });
  const items = await getFeedItems(ws);
  return NextResponse.json({ items }, {
    headers: { 'Cache-Control': 'private, s-maxage=20, stale-while-revalidate=60' },
  });
}
