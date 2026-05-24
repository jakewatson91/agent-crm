'use client';

/**
 * Client-side wrapper around FeedStream that uses SWR with server-supplied
 * fallbackData. On first render, hydration finds the data already populated —
 * no extra API round-trip. SWR still revalidates in the background after 10s
 * (the unstable_cache window in /api/feed/list).
 */
import { useMemo } from 'react';
import { useSWR, DEFAULT_SWR } from '../../../_lib/swr';
import { FeedStream } from './FeedStream';
import { useSetPageContext, type PageContext } from '../../../_components/PageContext';

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

export function FeedClient({ ws, initialItems }: { ws: string; initialItems: FeedItem[] }) {
  const { data } = useSWR<{ items: FeedItem[] }>(
    `/api/feed/list?workspace_id=${ws}`,
    { ...DEFAULT_SWR, fallbackData: { items: initialItems } },
  );
  const items = data?.items ?? initialItems;

  const pageCtx = useMemo<PageContext>(() => ({
    tab: 'feed',
    summary: `${items.length} recent posts (14d window)`,
    // Surface the most-recent posts as entity references — the agent operates
    // on entities, not posts, so we point at the entity for each row.
    visible: items.slice(0, 10).map((it) => ({
      kind: 'entity',
      id: it.entity_id,
      label: `${it.entity_name} (${it.kind})`,
    })),
  }), [items]);
  useSetPageContext(pageCtx);

  return <FeedStream items={items} ws={ws} />;
}
