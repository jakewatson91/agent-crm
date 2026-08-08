// Period digest: everything the platform did in a time window, per workspace.
//
// Usage:
//   pnpm report                                  last 24h, all active workspaces
//   pnpm report -- --hours 48                    rolling window
//   pnpm report -- --period 7d --ws Sudden       preset window, one workspace
//   pnpm report -- --period today|yesterday|30d
//   pnpm report -- --since 2026-07-01 --until 2026-07-08
//   pnpm report -- --json                        emit the raw PeriodData struct
//
// The heavy lifting (reads + rendering) lives in @agent-crm/tools/report so the
// same code can move behind an API route later. This file only parses args and
// picks which workspaces to run.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createServerClient } from '@agent-crm/db';
import { resolvePeriod, collectPeriod, renderMarkdown, type PeriodWindow, type CheckResult } from '@agent-crm/tools';

export function argVal(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

export function windowFromArgs(args: string[]): PeriodWindow {
  return resolvePeriod({
    since: argVal(args, 'since'),
    until: argVal(args, 'until'),
    period: argVal(args, 'period'),
    hours: argVal(args, 'hours') ? Number(argVal(args, 'hours')) : undefined,
  });
}

/**
 * Render the digest for every matching workspace. `checksOf` lets a caller that
 * already ran the sweep (scripts/recap.ts) pass those results through, so the
 * health section doesn't re-run every check.
 */
export async function runReport(
  sb: SupabaseClient,
  window: PeriodWindow,
  opts: { wsFilter?: string | null; asJson?: boolean; checksOf?: Map<string, CheckResult[]> } = {},
): Promise<void> {
  const { wsFilter = null, asJson = false, checksOf } = opts;
  const { data: workspaces, error } = await sb.from('workspaces').select('id, name');
  if (error) throw error;
  const targets = (workspaces ?? []).filter((w: { id: string; name: string }) => !wsFilter || w.id === wsFilter || w.name.toLowerCase().includes(wsFilter.toLowerCase()));
  if (!targets.length) { console.error(`No workspace matches "${wsFilter}"`); process.exit(1); }

  const collected: unknown[] = [];
  for (const w of targets) {
    // Skip silent workspaces when reporting on all of them.
    if (!wsFilter) {
      const { count } = await sb.from('events').select('id', { count: 'exact', head: true }).eq('workspace_id', w.id).gte('created_at', window.since).lt('created_at', window.until);
      if (!count) continue;
    }
    const data = await collectPeriod(sb, w.id, w.name, window, { checks: checksOf?.get(w.id) });
    if (asJson) { collected.push(data); continue; }
    console.log(renderMarkdown(data));
    console.log('\n---\n');
  }
  if (asJson) console.log(JSON.stringify(collected.length === 1 ? collected[0] : collected, null, 2));
}

async function main() {
  const args = process.argv.slice(2);
  await runReport(createServerClient(), windowFromArgs(args), {
    wsFilter: argVal(args, 'ws') ?? null,
    asJson: args.includes('--json'),
  });
}

// Only run when invoked directly; scripts/recap.ts imports runReport instead.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
