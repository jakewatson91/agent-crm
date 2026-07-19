/**
 * Per-workspace feed, pre-aggregated for the /workspace/[ws]/feed page.
 * Pipeline + 60s cache live in app/_lib/feed_items.ts, shared with the
 * page's server render.
 */
import { NextResponse } from 'next/server';
import { getFeedItems } from '../../../_lib/feed_items';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const ws = url.searchParams.get('workspace_id');
  if (!ws) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });
  const items = await getFeedItems(ws);
  return NextResponse.json({ items }, {
    headers: { 'Cache-Control': 'private, s-maxage=60, stale-while-revalidate=60' },
  });
}
