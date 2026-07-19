/**
 * Feed — SSR + SWR-with-fallback hybrid. The server inlines the feed payload
 * into the page response so the client component hydrates with fallbackData
 * and skips a round-trip. Pipeline + 60s cache live in app/_lib/feed_items.ts,
 * shared with /api/feed/list, so the SSR render and the client's SWR
 * revalidate hit the same cached result.
 */
import { getFeedItems } from '../../../_lib/feed_items';
import { FeedClient } from './FeedClient';

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
