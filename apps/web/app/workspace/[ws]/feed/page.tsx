/**
 * Feed — SSR + SWR-with-fallback hybrid. The server inlines the feed payload
 * into the page response so the client component hydrates with fallbackData
 * and skips a round-trip.
 */
import { createServerClient } from '@agent-crm/db';
import { FeedClient } from './FeedClient';

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
  pending_approval: boolean;
}

// Mirror of /api/feed/list — same Supabase pipeline.
const getFeedItems = async (ws: string): Promise<FeedItem[]> => {
  const supabase = createServerClient();
  const { data: posts } = await supabase
    .from('channel_posts')
    .select(`
      id, kind, body, cites, author_kind, author_id, created_at, parent_post_id,
      channels!inner(id, title, workspace_id, account_entity_id)
    `)
    .eq('channels.workspace_id', ws)
    .order('created_at', { ascending: false })
    .limit(400);

  const rows = (posts ?? []) as unknown as Array<{
    id: string; kind: string; body: string; cites: string[];
    author_kind: string; author_id: string; created_at: string;
    parent_post_id: string | null;
    channels: { id: string; title: string; account_entity_id: string };
  }>;

  // Which touch_draft posts still have an undecided gate → live approval queue.
  const draftIds = rows.filter((r) => r.kind === 'touch_draft').map((r) => r.id);
  const pendingDraft = new Set<string>();
  if (draftIds.length) {
    const { data: gateRows } = await supabase
      .from('gates')
      .select('channel_post_id, decided_at')
      .in('channel_post_id', draftIds);
    for (const g of (gateRows ?? []) as Array<{ channel_post_id: string; decided_at: string | null }>) {
      if (!g.decided_at) pendingDraft.add(g.channel_post_id);
    }
  }

  const entityIds = [...new Set(rows.map((r) => r.channels.account_entity_id))];
  const entMap = new Map<string, string>();
  const icpMap = new Map<string, number>();
  if (entityIds.length) {
    const [entsRes, fitsRes] = await Promise.all([
      supabase.from('entities').select('id, name').in('id', entityIds),
      supabase
        .from('facts')
        .select('subject_entity, object_text, supersedes, id')
        .eq('workspace_id', ws)
        .eq('predicate', 'icp_fit')
        .in('subject_entity', entityIds),
    ]);
    for (const e of (entsRes.data ?? []) as Array<{ id: string; name: string }>) entMap.set(e.id, e.name);
    const superseded = new Set<string>(((fitsRes.data ?? []) as any[]).map((f) => f.supersedes).filter(Boolean));
    for (const f of (fitsRes.data ?? []) as any[]) {
      if (superseded.has(f.id)) continue;
      const v = parseFloat(f.object_text);
      if (!isNaN(v) && !icpMap.has(f.subject_entity)) icpMap.set(f.subject_entity, v);
    }
  }

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
      pending_approval: pendingDraft.has(r.id),
    }));

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

export default async function FeedPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const items = await getFeedItems(ws);

  return (
    <section>
      <div style={{ marginBottom: '1.25rem' }}>
        <h2 style={{ margin: 0 }}>Feed</h2>
        <div className="subtle" style={{ fontSize: '.85rem', marginTop: '.25rem' }}>
          Consequential agent actions, newest first. Click an entity to walk its full timeline; click &ldquo;why?&rdquo; on any row for the agent&rsquo;s reasoning. Switch to Audit for the raw stream.
        </div>
      </div>
      <FeedClient ws={ws} initialItems={items} />
    </section>
  );
}
