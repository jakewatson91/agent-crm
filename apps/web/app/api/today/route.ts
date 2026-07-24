import { NextResponse } from 'next/server';
import { getTodayData, getTodayTrend } from '../../_lib/today';
import { getFeedItems } from '../../_lib/feed_items';

export const runtime = 'nodejs';

/**
 * The workspace home recap: what the agent did in the last 24 hours, the live
 * approval queue, and the 14-day trend. Every read is cached (today-data 120s,
 * feed-items 60s, trend 15m), so this is cheap on warm hits and shares the
 * feed's cache with the Feed tab.
 */
export async function GET(req: Request) {
  const ws = new URL(req.url).searchParams.get('workspace_id');
  if (!ws) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });

  const [today, feed, trend] = await Promise.all([getTodayData(ws), getFeedItems(ws), getTodayTrend(ws)]);
  const needsYou = feed.filter((i) => i.kind === 'touch_draft' && i.pending_approval);
  return NextResponse.json({ today, needsYou, trend });
}
