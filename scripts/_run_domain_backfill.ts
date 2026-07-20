// Drive the daily domain-backfill pass locally (same code the Inngest cron runs).
// Usage: pnpm tsx scripts/_run_domain_backfill.ts [limit]
//   limit caps how many candidates actually get resolved this run (0 = all).
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { scanDomainBackfillCandidates, runDomainBackfillBatch } from '../inngest/functions/system_tasks.ts';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const limit = Number(process.argv[2] ?? '0') || 0;

async function main() {
  const candidates = await scanDomainBackfillCandidates(sb as never);
  console.log(`eligible candidates today: ${candidates.length}`);
  const toRun = limit > 0 ? candidates.slice(0, limit) : candidates;
  if (!toRun.length) return;
  console.log(`resolving ${toRun.length}…`);
  const r = await runDomainBackfillBatch(sb as never, toRun);
  console.log(`resolved=${r.resolved} no_match=${r.no_match} errors=${r.errors} paused=${r.paused_workspaces.join(',') || 'none'}`);
  const ids = toRun.map((c) => c.entity_id);
  const { data } = await sb.from('entities').select('name, attributes').in('id', ids);
  for (const e of (data ?? []) as Array<{ name: string; attributes: { domain?: string } | null }>) {
    console.log(`  ${e.name}: ${e.attributes?.domain ?? '(no match)'}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
