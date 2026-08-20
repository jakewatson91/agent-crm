/**
 * Per-workspace entity index, pre-aggregated for the /workspace/[ws]/entities page.
 *
 * Returns the entities the page renders, the latest ICP-fit per entity, and the
 * last agent activity per account — all in one round trip. Output shape uses
 * arrays-of-entries (not Maps) so SWR can cache + serialize the payload cleanly.
 *
 * Data pipeline lives in app/_lib/entities_index.ts, shared with the SSR page,
 * so the server render and the client's SWR revalidate hit the same cache.
 */
import { NextResponse } from 'next/server';
import { getEntitiesPageData } from '../../../_lib/entities_index';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const ws = url.searchParams.get('workspace_id');
  if (!ws) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });
  const data = await getEntitiesPageData(ws);
  return NextResponse.json(data, {
    headers: { 'Cache-Control': 'private, s-maxage=300, stale-while-revalidate=300' },
  });
}
