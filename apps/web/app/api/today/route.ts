import { NextResponse } from 'next/server';
import { getTodayData } from '../../_lib/today';
import { getFeedItems } from '../../_lib/feed_items';

export const runtime = 'nodejs';

/**
 * The workspace home briefing: the agent's summary of the last day + the live
 * approval queue. Both reads are cached (today-data 120s, feed-items 60s), so
 * this is cheap on warm hits and shares the feed's cache with the Feed tab.
 */
export async function GET(req: Request) {
  const ws = new URL(req.url).searchParams.get('workspace_id');
  if (!ws) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });

  const [today, feed] = await Promise.all([getTodayData(ws), getFeedItems(ws)]);
  const needsYou = feed.filter((i) => i.kind === 'touch_draft' && i.pending_approval);
  return NextResponse.json({ today, needsYou });
}
