/**
 * Cron → minimum interval in minutes. Not a full parser — handles the patterns
 * our connector registry emits and the patterns customers tend to write:
 *
 *   *\/N * * * *      → every N minutes
 *   0 *\/N * * *      → every N hours
 *   0 * * * *         → hourly
 *   0 H * * *         → daily at hour H
 *   0 H D * *         → monthly on day D, hour H (~43200 min)
 *   0 H 1 *\/N *      → every N months on the 1st (yc quarterly = 1/4/7/10)
 *
 * Used by both the source-dispatcher (decides whether a source is due) and the
 * sweep (decides whether a source's last_run_at is stale relative to its
 * declared cadence — so quarterly YC sources don't trip on the same 24h
 * threshold as an hourly RSS feed).
 *
 * Fallback for unrecognized patterns: 60 (treat as hourly). Conservative;
 * caller should add a slack multiplier.
 */
export function cronToMinIntervalMinutes(cron: string | null | undefined): number {
  if (!cron || typeof cron !== 'string') return 60;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return 60;
  const [min, hour, dom, mon] = parts as [string, string, string, string, string];

  // Every N minutes: */N * * * *
  const everyNMin = min.match(/^\*\/(\d+)$/);
  if (everyNMin && hour === '*') return Math.max(1, parseInt(everyNMin[1]!, 10));

  // Every N hours: 0 */N * * *
  const everyNHour = hour.match(/^\*\/(\d+)$/);
  if (everyNHour) return Math.max(1, parseInt(everyNHour[1]!, 10)) * 60;

  // Hourly: 0 * * * *
  if (/^\d+$/.test(min) && hour === '*') return 60;

  // Daily / monthly / "every N months on 1st" — only when min + hour are fixed
  if (/^\d+$/.test(min) && /^\d+$/.test(hour)) {
    const everyNMon = mon.match(/^\*\/(\d+)$/);
    if (everyNMon && /^\d+$/.test(dom)) {
      // Every N months → ~30*N days
      return Math.max(1, parseInt(everyNMon[1]!, 10)) * 30 * 1440;
    }
    if (/^\d+$/.test(dom) && mon === '*') return 30 * 1440;   // monthly
    if (dom === '*' && mon === '*') return 1440;              // daily
  }
  return 60;
}
