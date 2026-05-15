import { createServerClient } from '@agent-crm/db';
import { FeedStream } from './FeedStream';

export const dynamic = 'force-dynamic';

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
  reasoning: string | null;   // body of the child decision post, if collapsed in
  dup_count: number;          // number of identical rows collapsed into this one (1 = no duplicates)
}

export default async function FeedPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const supabase = createServerClient();

  // Pull last N posts. We over-fetch (400) so parent-collapse and dedup leave
  // enough rows to render. The stream UI loads more on demand.
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

  // Entity name lookup. The channels.title is set on creation but entities
  // can be renamed; prefer the entity's current name.
  const entityIds = [...new Set(rows.map((r) => r.channels.account_entity_id))];
  const entMap = new Map<string, string>();
  if (entityIds.length) {
    const ents = await supabase.from('entities').select('id, name').in('id', entityIds);
    for (const e of (ents.data ?? []) as Array<{ id: string; name: string }>) entMap.set(e.id, e.name);
  }

  // Latest icp_fit per entity for the score badge.
  const icpMap = new Map<string, number>();
  if (entityIds.length) {
    const fits = await supabase
      .from('facts')
      .select('subject_entity, object_text, supersedes, id')
      .eq('workspace_id', ws)
      .eq('predicate', 'icp_fit')
      .in('subject_entity', entityIds);
    const superseded = new Set<string>(((fits.data ?? []) as any[]).map((f) => f.supersedes).filter(Boolean));
    for (const f of (fits.data ?? []) as any[]) {
      if (superseded.has(f.id)) continue;
      const v = parseFloat(f.object_text);
      if (!isNaN(v) && !icpMap.has(f.subject_entity)) icpMap.set(f.subject_entity, v);
    }
  }

  // Parent-collapse: when a `decision` is a child of a `touch_draft` or `claim`,
  // attach its body as `reasoning` on the parent and drop the child as a top-level row.
  // The agent's "why" then renders as an expandable section on the parent card,
  // not as a separate row in the feed.
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
  // Keep newest; count how many we collapsed so the UI can show "+N more times".
  // 14d is long enough to catch weekly re-emit patterns, short enough that a
  // genuinely-new fact still surfaces on its own.
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
  const items: FeedItem[] = [...grouped.values()].sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
  );

  return (
    <section>
      <div style={{ marginBottom: '1.25rem' }}>
        <h2 style={{ margin: 0 }}>Feed</h2>
        <div className="subtle" style={{ fontSize: '.85rem', marginTop: '.25rem' }}>
          Consequential agent actions, newest first. Click an entity to walk its full timeline; click &ldquo;why?&rdquo; on any row for the agent&rsquo;s reasoning. Switch to Audit for the raw stream.
        </div>
      </div>
      <FeedStream items={items} ws={ws} />
    </section>
  );
}
