/**
 * sweep CLI - thin formatter over @agent-crm/tools sweepWorkspace.
 *
 * Usage:
 *   pnpm sweep               # all workspaces, full report
 *   pnpm sweep --ws=<id>     # one workspace
 *   pnpm sweep --quiet       # suppress GREEN lines (for SessionStart hook)
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { sweepWorkspace, SWEEP_THRESHOLDS, type CheckResult } from '@agent-crm/tools';

function printReport(ws: { id: string; name: string }, results: CheckResult[], quiet: boolean) {
  const red = results.filter((r) => r.severity === 'red');
  const yellow = results.filter((r) => r.severity === 'yellow');
  const green = results.filter((r) => r.severity === 'green');

  console.log(`\nWORKSPACE  ${ws.name} (${ws.id.slice(0, 8)})`);
  console.log(`  RED=${red.length}  YELLOW=${yellow.length}  GREEN=${green.length}`);

  if (red.length) {
    console.log(`  RED`);
    for (const r of red) console.log(`    ${r.id.padEnd(40)} ${r.metric}   ${r.threshold ? `(threshold ${r.threshold})` : ''}`);
  }
  if (yellow.length) {
    console.log(`  YELLOW`);
    for (const r of yellow) console.log(`    ${r.id.padEnd(40)} ${r.metric}   ${r.threshold ? `(threshold ${r.threshold})` : ''}`);
  }
  if (!quiet && green.length) {
    console.log(`  GREEN`);
    for (const r of green) console.log(`    ${r.id.padEnd(40)} ${r.metric}`);
  }
  const actions = [...red, ...yellow].filter((r) => r.action).map((r) => `    - [${r.id}] ${r.action}`);
  if (actions.length) {
    console.log(`  ACTION`);
    for (const a of actions) console.log(a);
  }
}

export function sweepClient(): SupabaseClient | null {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  );
}

/**
 * Sweep every workspace (or one) and print the report. Returns the checks per
 * workspace id so a caller that also builds the period digest can hand them to
 * collectPeriod instead of running all of it again — see scripts/recap.ts.
 */
export async function runSweep(sb: SupabaseClient, opts: { quiet?: boolean; wsId?: string } = {}): Promise<Map<string, CheckResult[]>> {
  const quiet = opts.quiet ?? false;
  const T = SWEEP_THRESHOLDS;
  const wsQ = opts.wsId
    ? sb.from('workspaces').select('id, name').eq('id', opts.wsId)
    : sb.from('workspaces').select('id, name').order('created_at', { ascending: false });
  const wsRes = await wsQ;
  const workspaces = ((wsRes.data ?? []) as Array<{ id: string; name: string }>);

  console.log(`SWEEP  ${new Date().toISOString()}  (${workspaces.length} workspace${workspaces.length === 1 ? '' : 's'})`);
  console.log(`  thresholds: diversity<${T.diversity_red} src_share>${T.source_share_red} novelty>${T.novelty_overlap_red} cron>${T.cron_stale_red_mult}×expected decile>${T.score_decile_red} coupling<${T.coupling_red}`);

  const byWorkspace = new Map<string, CheckResult[]>();
  let totalRed = 0; let totalYellow = 0;
  for (const ws of workspaces) {
    const results = await sweepWorkspace(sb, ws.id);
    byWorkspace.set(ws.id, results);
    totalRed += results.filter((r) => r.severity === 'red').length;
    totalYellow += results.filter((r) => r.severity === 'yellow').length;
    if (quiet && results.filter((r) => r.severity !== 'green').length === 0) continue;
    printReport(ws, results, quiet);
  }

  console.log(`\nTOTAL  red=${totalRed} yellow=${totalYellow}`);
  return byWorkspace;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const sb = sweepClient();
  if (!sb) {
    console.log('SWEEP  (skipped - no .env.local with SUPABASE creds)');
    return;
  }
  await runSweep(sb, {
    quiet: args.has('--quiet'),
    wsId: [...args].find((a) => a.startsWith('--ws='))?.slice(5),
  });
}

// Only run when invoked directly; scripts/recap.ts imports runSweep instead.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((e) => { console.error('sweep failed:', e); process.exit(1); });
}
