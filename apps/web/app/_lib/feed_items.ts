/**
 * Shared feed pipeline for /workspace/[ws]/feed (SSR) and /api/feed/list.
 * One implementation, one 60s cache (tag 'feed', invalidated on gate
 * decisions), so the server-rendered page and the client's SWR revalidate
 * hit the same cached result instead of each re-running the queries.
 *
 * The last ~400 activity posts + ~200 consequential posts, parent-collapsed
 * and 14d-deduped. claim/decision/system/question are high-volume — a
 * research-enrichment burst can produce hundreds in an hour — while
 * touch_draft/gate_request/outcome are rare but consequential. Separate
 * windows so the noisy kinds can't push approvals out of the feed.
 */
import { unstable_cache } from 'next/cache';
import { createServerClient } from '@agent-crm/db';

export interface FeedItem {
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
  // True only for touch_draft rows whose outreach gate is still undecided —
  // i.e. the live approval queue. Sent/rejected drafts and non-draft rows are false.
  pending_approval: boolean;
  // The outreach gate tied to this draft, inlined so the draft card doesn't
  // re-fetch it per post (that was an N+1: one /gates/by-post call per row).
  // null on non-draft rows and drafts with no gate.
  gate: Gate | null;
  // How much this claim's facts moved the account's score. Only set on
  // enricher-sourced claims that triggered a rescore; null otherwise.
  score_delta: number | null;
}

export interface Gate {
  id: string;
  policy: string;
  condition: Record<string, unknown> | null;
  decision: 'approve' | 'reject' | 'modify' | null;
  decided_at: string | null;
}

const ACTIVITY_KINDS = ['claim', 'decision', 'system', 'question'];
const CONSEQUENTIAL_KINDS = ['touch_draft', 'gate_request', 'outcome'];

const POST_SELECT = `
  id, kind, body, cites, author_kind, author_id, created_at, parent_post_id, score_delta,
  channels!inner(id, title, workspace_id, account_entity_id,
    entity:entities(id, name)
  )
`;

const _getFeedItems = async (ws: string): Promise<FeedItem[]> => {
  const supabase = createServerClient();

  // Round 1: both post windows in parallel (entity name joined inline).
  const [activityRes, consequentialRes] = await Promise.all([
    supabase
      .from('channel_posts')
      .select(POST_SELECT)
      .eq('channels.workspace_id', ws)
      .in('kind', ACTIVITY_KINDS)
      .order('created_at', { ascending: false })
      .limit(400),
    supabase
      .from('channel_posts')
      .select(POST_SELECT)
      .eq('channels.workspace_id', ws)
      .in('kind', CONSEQUENTIAL_KINDS)
      .order('created_at', { ascending: false })
      .limit(200),
  ]);

  const rows = [...(activityRes.data ?? []), ...(consequentialRes.data ?? [])] as unknown as Array<{
    id: string; kind: string; body: string; cites: string[];
    author_kind: string; author_id: string; created_at: string;
    parent_post_id: string | null; score_delta: number | null;
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

  const draftIds = rows.filter((r) => r.kind === 'touch_draft').map((r) => r.id);
  const entityIds = [...new Set(rows.map((r) => r.channels.account_entity_id))];

  // Round 2 (both need round-1 ids): gates for the draft rows + icp_fit facts
  // scoped to the entities actually in the window. Scoping matters twice over:
  // an unscoped read of this workspace's icp_fit rows hits the PostgREST
  // 1000-row cap (arbitrary subset), and filtering with .is('supersedes',null)
  // returns the STALE ORIGINAL fact, not the current one. Instead fetch the
  // chain for these entities and drop any fact another fact points at.
  const [gatesRes, fitsRes] = await Promise.all([
    draftIds.length
      ? supabase
          .from('gates')
          .select('id, policy, condition, decision, decided_at, requested_at, channel_post_id')
          .in('channel_post_id', draftIds)
          .order('requested_at', { ascending: false })
      : Promise.resolve({ data: [] }),
    entityIds.length
      ? supabase
          .from('facts')
          .select('id, subject_entity, object_text, supersedes')
          .eq('workspace_id', ws)
          .eq('predicate', 'icp_fit')
          .in('subject_entity', entityIds)
          .order('observed_at', { ascending: false })
      : Promise.resolve({ data: [] }),
  ]);

  // Latest gate wins per post (requested_at desc), mirroring the by-post route.
  const gateByPost = new Map<string, Gate>();
  const pendingDraft = new Set<string>();
  for (const g of (gatesRes.data ?? []) as Array<{ id: string; policy: string; condition: Record<string, unknown> | null; decision: Gate['decision']; decided_at: string | null; requested_at: string; channel_post_id: string }>) {
    if (gateByPost.has(g.channel_post_id)) continue; // first = latest (ordered desc)
    gateByPost.set(g.channel_post_id, { id: g.id, policy: g.policy, condition: g.condition, decision: g.decision, decided_at: g.decided_at });
    if (!g.decided_at) pendingDraft.add(g.channel_post_id);
  }

  type FitRow = { id: string; subject_entity: string; object_text: string; supersedes: string | null };
  const fitRows = (fitsRes.data ?? []) as FitRow[];
  const superseded = new Set(fitRows.map((f) => f.supersedes).filter(Boolean));
  const icpMap = new Map<string, number>();
  for (const f of fitRows) {
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
      pending_approval: pendingDraft.has(r.id),
      gate: gateByPost.get(r.id) ?? null,
      score_delta: r.score_delta,
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

export const getFeedItems = unstable_cache(
  _getFeedItems,
  ['feed-items'],
  { revalidate: 60, tags: ['feed'] },
);
