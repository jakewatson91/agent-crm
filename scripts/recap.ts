/**
 * recap = the health sweep followed by the period digest, in one process.
 *
 * `pnpm recap` used to be `pnpm sweep && pnpm report`. Both surfaces run the same
 * checks — the digest's "Health now" section calls sweepWorkspace itself — so a
 * four-workspace install ran every check twice, and a failing sweep meant `&&`
 * swallowed the digest entirely. Here the sweep runs once and its results are
 * handed to the report.
 *
 * Usage: same flags as the two it replaces.
 *   pnpm recap
 *   pnpm recap -- --period 7d --ws Sudden
 *   pnpm recap -- --quiet          suppress GREEN lines in the sweep section
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { runSweep, sweepClient } from './sweep.ts';
import { runReport, argVal, windowFromArgs } from './daily_report.ts';

async function main() {
  const args = process.argv.slice(2);
  const sb = sweepClient();
  if (!sb) {
    console.error('recap: no .env.local with NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  const wsFilter = argVal(args, 'ws') ?? null;
  // The sweep takes a workspace id; --ws also accepts a name for the report, so
  // only pass it through when it looks like an id.
  const wsId = wsFilter && /^[0-9a-f-]{36}$/i.test(wsFilter) ? wsFilter : undefined;

  const checksOf = await runSweep(sb, { quiet: args.includes('--quiet'), wsId });
  console.log('\n---\n');
  await runReport(sb, windowFromArgs(args), { wsFilter, asJson: args.includes('--json'), checksOf });
}

main().catch((e) => { console.error('recap failed:', e); process.exit(1); });
