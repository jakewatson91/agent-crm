/**
 * Workspace home = the agent's "Today" recap (see TodayClient). Server reads the
 * cached today-data, feed items and 14-day trend, and inlines them so the page
 * hydrates with no extra round-trip. Auth is enforced by the workspace layout
 * (requireRole).
 */
import { getTodayData, getTodayTrend } from '../../_lib/today';
import { getFeedItems } from '../../_lib/feed_items';
import { TodayClient } from './TodayClient';

export default async function WorkspaceHome({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const [today, feed, trend] = await Promise.all([getTodayData(ws), getFeedItems(ws), getTodayTrend(ws)]);
  const needsYou = feed.filter((i) => i.kind === 'touch_draft' && i.pending_approval);
  return <TodayClient ws={ws} initialToday={today} initialNeedsYou={needsYou} initialTrend={trend} />;
}
