/**
 * One-off: quiet af602fa1 (the dogfood workspace) while the Sudden CSV import
 * and initial scoring burst runs, so both don't compete for the same shared
 * DeepSeek/Hunter/Explorium/Exa quota. Two independent levers:
 *
 *  1. policy.pipeline -> paused, scope:'all'. advanceAccounts() (the daily
 *     contacts+drafts pass) checks this and skips the workspace entirely.
 *     Visible on every af602fa1 page via the amber PipelineBanner.
 *  2. policy.research.searches_per_run -> 0. entityResearchDispatcher (every
 *     4h) does NOT check policy.pipeline at all, so lever 1 alone doesn't stop
 *     it; zeroing its budget makes it choose nothing for af602fa1. NOT
 *     surfaced anywhere in the UI — restoring this is on the honor system,
 *     which is why `continue` mode logs the value it's restoring.
 *
 * sources.active is deliberately left alone: af602fa1 has 20 source rows and
 * only 1 active (ats_hiring_main, daily cron, already ran today) — nothing
 * left to fire from it during a same-day burst. See the plan file for the
 * reasoning if that changes.
 *
 * Usage: tsx scripts/_quiet_dogfood_for_sudden_burst.ts pause|continue
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { getPipelineStatus, setPipelineStatus, type WorkspacePolicy } from '@agent-crm/tools';

const WS = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
const DEFAULT_SEARCHES_PER_RUN = 30;

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

async function rawPolicy(): Promise<WorkspacePolicy> {
  const r = await sb.from('workspaces').select('policy').eq('id', WS).maybeSingle();
  if (r.error || !r.data) throw new Error(`could not read workspace ${WS}: ${r.error?.message}`);
  return (r.data.policy ?? {}) as WorkspacePolicy;
}

async function setSearchesPerRun(value: number) {
  // Read-modify-write on the FULL policy row — set_workspace_policy's DB
  // handler does a top-level replace of `policy`, not a merge, so writing a
  // partial object here would silently wipe every other policy key.
  const policy = await rawPolicy();
  const next: WorkspacePolicy = { ...policy, research: { ...(policy.research ?? {}), searches_per_run: value } };
  const { error } = await sb.from('workspaces').update({ policy: next }).eq('id', WS);
  if (error) throw new Error(`failed to update research.searches_per_run: ${error.message}`);
}

async function main() {
  const mode = process.argv[2];
  if (mode !== 'pause' && mode !== 'continue') {
    console.error('usage: tsx scripts/_quiet_dogfood_for_sudden_burst.ts pause|continue');
    process.exit(1);
  }

  const policyBefore = await rawPolicy();
  const priorSearchesPerRun = policyBefore.research?.searches_per_run ?? DEFAULT_SEARCHES_PER_RUN;
  const priorPipeline = await getPipelineStatus(sb, WS);
  console.log(`af602fa1 before: pipeline=${JSON.stringify(priorPipeline)} searches_per_run=${priorSearchesPerRun}`);

  if (mode === 'pause') {
    await setPipelineStatus(sb, WS, {
      state: 'paused',
      scope: 'all',
      reason: 'Manual pause — reserving shared DeepSeek/Hunter/Explorium/Exa quota for the Sudden CSV import + initial scoring burst. Click Continue (or rerun this script with "continue") once the burst is stable.',
      paused_at: new Date().toISOString(),
    });
    await setSearchesPerRun(0);
    console.log('af602fa1 quieted: pipeline paused (scope: all), research searches_per_run = 0');
    console.log(`remember: prior searches_per_run was ${priorSearchesPerRun} — restore it with "continue"`);
  } else {
    await setPipelineStatus(sb, WS, {
      state: 'ok',
      last_run_at: priorPipeline?.last_run_at,
      last_run: priorPipeline?.last_run,
    });
    // Restore to the default rather than whatever was captured on a possible
    // second "pause" run (which would have already been 0) — 30 is the
    // documented default and what af602fa1 was actually running before today.
    await setSearchesPerRun(DEFAULT_SEARCHES_PER_RUN);
    console.log(`af602fa1 restored: pipeline ok, research searches_per_run = ${DEFAULT_SEARCHES_PER_RUN}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
