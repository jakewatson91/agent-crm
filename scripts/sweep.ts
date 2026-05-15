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
import { createClient } from '@supabase/supabase-js';
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

async function main() {
  const args = new Set(process.argv.slice(2));
  const quiet = args.has('--quiet');
  const wsArg = [...args].find((a) => a.startsWith('--ws='))?.slice(5);

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log('SWEEP  (skipped - no .env.local with SUPABASE creds)');
    return;
  }
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  );

  const T = SWEEP_THRESHOLDS;
  const wsQ = wsArg
    ? sb.from('workspaces').select('id, name').eq('id', wsArg)
    : sb.from('workspaces').select('id, name').order('created_at', { ascending: false });
  const wsRes = await wsQ;
  const workspaces = ((wsRes.data ?? []) as Array<{ id: string; name: string }>);

  console.log(`SWEEP  ${new Date().toISOString()}  (${workspaces.length} workspace${workspaces.length === 1 ? '' : 's'})`);
  console.log(`  thresholds: diversity<${T.diversity_red} src_share>${T.source_share_red} novelty>${T.novelty_overlap_red} cron>${T.cron_stale_h_red}h decile>${T.score_decile_red} coupling<${T.coupling_red}`);

  let totalRed = 0; let totalYellow = 0;
  for (const ws of workspaces) {
    const results = await sweepWorkspace(sb, ws.id);
    totalRed += results.filter((r) => r.severity === 'red').length;
    totalYellow += results.filter((r) => r.severity === 'yellow').length;
    if (quiet && results.filter((r) => r.severity !== 'green').length === 0) continue;
    printReport(ws, results, quiet);
  }

  console.log(`\nTOTAL  red=${totalRed} yellow=${totalYellow}`);
}

main().catch((e) => { console.error('sweep failed:', e); process.exit(1); });
