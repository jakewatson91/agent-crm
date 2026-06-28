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

interface Gate {
  id: string;
  policy: string;
  condition: Record<string, unknown> | null;
  decision: 'approve' | 'reject' | 'modify' | null;
  decided_at: string | null;
}

// claim/decision/system/question are high-volume — a research-enrichment burst
// can produce hundreds of these in an hour. touch_draft/gate_request/outcome are
// rare but consequential (approvals, outreach, results). A single shared
// .limit() ordered by recency lets the noisy kinds push the rare ones completely
// out of the window — Outreach/Needs-approval chips would read 0 even when real
// rows exist, just further back than the cutoff. Fetch them in separate windows
// so neither starves the other.
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

  // Fire posts (with entity name joined) + icp_fit facts in parallel.
  // Facts is scoped to the workspace's icp_fit rows — typically O(entities), not large.
  const [activityRes, consequentialRes, fitsRes] = await Promise.all([
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
    supabase
      .from('facts')
      .select('subject_entity, object_text')
      .eq('workspace_id', ws)
      .eq('predicate', 'icp_fit')
      .is('supersedes', null),
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

  // Gate per touch_draft post, fetched once for the whole window (was N+1: the
  // draft card fired one /gates/by-post call per row). pending_approval and the
  // inlined gate object both come from this single query. Latest gate wins per
  // post (requested_at desc), mirroring the by-post route.
  const draftIds = rows.filter((r) => r.kind === 'touch_draft').map((r) => r.id);
  const gateByPost = new Map<string, Gate>();
  const pendingDraft = new Set<string>();
  if (draftIds.length) {
    const { data: gateRows } = await supabase
      .from('gates')
      .select('id, policy, condition, decision, decided_at, requested_at, channel_post_id')
      .in('channel_post_id', draftIds)
      .order('requested_at', { ascending: false });
    for (const g of (gateRows ?? []) as Array<{ id: string; policy: string; condition: Record<string, unknown> | null; decision: Gate['decision']; decided_at: string | null; requested_at: string; channel_post_id: string }>) {
      if (gateByPost.has(g.channel_post_id)) continue; // first = latest (ordered desc)
      gateByPost.set(g.channel_post_id, { id: g.id, policy: g.policy, condition: g.condition, decision: g.decision, decided_at: g.decided_at });
      if (!g.decided_at) pendingDraft.add(g.channel_post_id);
    }
  }

  const icpMap = new Map<string, number>();
  for (const f of (fitsRes.data ?? []) as any[]) {
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

const getFeedItems = unstable_cache(
  _getFeedItems,
  ['feed-items'],
  { revalidate: 60, tags: ['feed'] },
);

export async function GET(req: Request) {
  const url = new URL(req.url);
  const ws = url.searchParams.get('workspace_id');
  if (!ws) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });
  const items = await getFeedItems(ws);
  return NextResponse.json({ items }, {
    headers: { 'Cache-Control': 'private, s-maxage=60, stale-while-revalidate=60' },
  });
}
