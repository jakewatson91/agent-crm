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
}

export default async function FeedPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const supabase = createServerClient();

  // Pull the last N posts across every channel in this workspace.
  // 200 is the cap; the stream UI loads more on demand.
  const { data: posts } = await supabase
    .from('channel_posts')
    .select(`
      id, kind, body, cites, author_kind, author_id, created_at,
      channels!inner(id, title, workspace_id, account_entity_id)
    `)
    .eq('channels.workspace_id', ws)
    .order('created_at', { ascending: false })
    .limit(200);

  const rows = (posts ?? []) as unknown as Array<{
    id: string; kind: string; body: string; cites: string[];
    author_kind: string; author_id: string; created_at: string;
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

  const items: FeedItem[] = rows.map((r) => ({
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
  }));

  return (
    <section>
      <div style={{ marginBottom: '1.25rem' }}>
        <h2 style={{ margin: 0 }}>Feed</h2>
        <div className="subtle" style={{ fontSize: '.85rem', marginTop: '.25rem' }}>
          Every action the agent has taken. Newest first. Click an entity name to walk its full timeline; click a draft or decision to expand.
        </div>
      </div>
      <FeedStream items={items} ws={ws} />
    </section>
  );
}
