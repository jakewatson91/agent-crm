/**
 * Run the daily domain backfill right now instead of waiting for the 11:00 UTC
 * cron. Same two functions domainBackfillDaily calls, in the same order, with
 * the same per-workspace budget (policy.research.domain_backfill_per_day).
 *
 * Use when the cron has missed days, or right after a rescore: candidates are
 * ordered by icp_fit, so a rescore that reranks the book changes who the day's
 * budget goes to, and the ordering only takes effect the next time this runs.
 *
 * Spends real Exa credit: one guarded search per candidate.
 *
 * Usage: tsx scripts/_run_domain_backfill_now.ts [--apply]
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
import { scanDomainBackfillCandidates, runDomainBackfillBatch } from '../inngest/functions/system_tasks.ts';

const APPLY = process.argv.includes('--apply');

async function main() {
  const sb = createServerClient();
  const candidates = await scanDomainBackfillCandidates(sb);
  console.log(`${candidates.length} candidate(s) today, in the order the budget will be spent:`);
  for (const c of candidates.slice(0, 15)) console.log(`  ${c.entity_name}`);
  if (candidates.length > 15) console.log(`  ... and ${candidates.length - 15} more`);
  if (!APPLY) { console.log('\nDry run. Re-run with --apply to spend the searches.'); return; }
  const r = await runDomainBackfillBatch(sb, candidates);
  console.log(`\nresolved=${r.resolved}  no_match=${r.no_match}  errors=${r.errors}${r.paused_workspaces.length ? `  paused=${r.paused_workspaces.join(',')}` : ''}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
