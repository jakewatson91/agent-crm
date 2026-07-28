'use client';

/**
 * Client-side wrapper around FeedStream that uses SWR with server-supplied
 * fallbackData. On first render, hydration finds the data already populated —
 * no extra API round-trip. Polls every 60s (matching /api/feed/list's server
 * cache window) so a feed tab left open picks up new agent activity without
 * a manual reload.
 */
import { useSWR, DEFAULT_SWR } from '../../../_lib/swr';
import { FeedStream } from './FeedStream';
import { FeedHealth } from './FeedHealth';

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
  gate: { id: string; policy: string; condition: Record<string, unknown> | null; decision: 'approve' | 'reject' | 'modify' | null; decided_at: string | null } | null;
  score_delta: number | null;
}

export function FeedClient({ ws, initialItems }: { ws: string; initialItems: FeedItem[] }) {
  const { data, mutate } = useSWR<{ items: FeedItem[] }>(
    `/api/feed/list?workspace_id=${ws}`,
    { ...DEFAULT_SWR, fallbackData: { items: initialItems }, refreshInterval: 60_000 },
  );
  const items = data?.items ?? initialItems;

  // Page context for ⌘J chat is set by FeedStream, which owns the active
  // filter state and therefore knows exactly what's visible.
  return (
    <>
      <FeedHealth ws={ws} />
      <FeedStream items={items} ws={ws} onDecided={() => mutate()} />
    </>
  );
}
