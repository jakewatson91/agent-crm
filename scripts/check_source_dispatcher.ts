/**
 * Assertions for selectDueSources — which sources the hourly dispatcher fans
 * out a `source.run` event for.
 *
 * Regression guard for the 2026-08-01 bug: a workspace paused for a DeepSeek
 * credit wall blanket-skipped every active source, including free ones (ats,
 * hn, yc, github, producthunt) that don't touch a paid API and gained nothing
 * from sitting out the pause. `ats_hiring_main` stayed stuck at its last run
 * for the entire wall. Fix: only a 'metered' connector is skipped for pause;
 * free connectors are still gated by their own cron interval.
 *
 * Uses the real connector registry (not a mock), so this also catches a
 * connector's `cost` classification silently changing.
 *
 * Run: tsx scripts/check_source_dispatcher.ts   (exits non-zero on failure)
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { selectDueSources, type DueSourceRow } from '../inngest/functions/sources/dispatcher.ts';

let fail = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
}

const now = Date.parse('2026-08-04T12:00:00Z');
const daysAgo = (d: number) => new Date(now - d * 86400_000).toISOString();
const wsPaused = 'ws-paused';
const wsLive = 'ws-live';
const paused = new Set([wsPaused]);

console.log('selectDueSources — pause only stops metered connectors:');

eq(
  'free connector (ats) still runs in a paused workspace once its own cron is due',
  selectDueSources(
    [{ id: 'ats-1', workspace_id: wsPaused, connector_type: 'ats', last_run_at: daysAgo(2) }],
    paused, now,
  ).due,
  [{ id: 'ats-1', workspace_id: wsPaused }],
);

eq(
  'metered connector (exa) is skipped in a paused workspace even when its cron is due',
  selectDueSources(
    [{ id: 'exa-1', workspace_id: wsPaused, connector_type: 'exa', last_run_at: daysAgo(2) }],
    paused, now,
  ).due,
  [],
);

eq(
  'free connector still respects its own cron interval — not due yet, paused or not',
  selectDueSources(
    [{ id: 'ats-2', workspace_id: wsPaused, connector_type: 'ats', last_run_at: daysAgo(0.1) }],
    paused, now,
  ).due,
  [],
);

eq(
  'metered connector runs normally in a workspace that is not paused',
  selectDueSources(
    [{ id: 'exa-2', workspace_id: wsLive, connector_type: 'exa', last_run_at: daysAgo(1) }],
    paused, now,
  ).due,
  [{ id: 'exa-2', workspace_id: wsLive }],
);

eq(
  'unknown connector_type is skipped, not thrown',
  selectDueSources(
    [{ id: 'x-1', workspace_id: wsLive, connector_type: 'not_a_real_connector', last_run_at: null }],
    paused, now,
  ).due,
  [],
);

eq(
  'a brand-new source (never run) is due immediately regardless of pause, if free',
  selectDueSources(
    [{ id: 'ats-3', workspace_id: wsPaused, connector_type: 'ats', last_run_at: null }],
    paused, now,
  ).due,
  [{ id: 'ats-3', workspace_id: wsPaused }],
);

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
