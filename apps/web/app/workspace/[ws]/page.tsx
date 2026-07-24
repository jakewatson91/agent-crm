/**
 * Workspace home = the agent's "Today" briefing (see TodayClient). Server reads
 * the cached today-data + feed items and inlines them so the page hydrates with
 * no extra round-trip. Auth is enforced by the workspace layout (requireRole).
 */
import { getTodayData } from '../../_lib/today';
import { getFeedItems } from '../../_lib/feed_items';
import { TodayClient } from './TodayClient';

export default async function WorkspaceHome({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const [today, feed] = await Promise.all([getTodayData(ws), getFeedItems(ws)]);
  const needsYou = feed.filter((i) => i.kind === 'touch_draft' && i.pending_approval);
  return <TodayClient ws={ws} initialToday={today} initialNeedsYou={needsYou} />;
}
