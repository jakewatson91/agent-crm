/**
 * Run what the dispatcher runs, now rather than at the next 4h tick.
 *
 * Brief first, then strategy, the same order entity_research_dispatcher uses:
 * every angle carries `answers: <question id>`, so planning angles against a
 * brief that is about to change writes angles pointing at the old wording.
 *
 * Expected chain, all of it automatic from here:
 *   1. max_age_days is now part of the brief input hash, so the brief is stale
 *      and regenerates, this time told the 90-day floor. The question asking what
 *      a leader said "in the past year" is asking for pages binned on arrival.
 *   2. the new brief is newer than the strategy, so the strategy regenerates too,
 *      with each angle's record in front of the planner.
 *   3. the technical_leader angle is at 81 fetched / 0 answering its question, so
 *      the planner is told that query cannot work as written.
 *
 * Ids are preserved by both planners, so nothing loses its track record.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
import { ensureResearchBrief, ensureResearchStrategy, getPolicy } from '@agent-crm/tools';

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

async function main() {
  const sb = createServerClient();
  const before = await getPolicy(sb, WS);
  console.log('BEFORE');
  for (const q of before.research?.brief ?? []) console.log(`  ${q.id.padEnd(20)} ${q.question}`);

  const brief = await ensureResearchBrief(sb, WS);
  console.log('\nAFTER brief');
  for (const q of brief) console.log(`  ${q.id.padEnd(20)} ${q.question}`);

  const angles = await ensureResearchStrategy(sb, WS);
  console.log('\nAFTER strategy');
  for (const a of angles) {
    console.log(`  ${a.id.padEnd(26)} [${a.domain_scope}] answers=${a.answers ?? '-'} recency=${a.recency_days ?? '-'}`);
    console.log(`      ${a.query_template}`);
  }

  const after = await getPolicy(sb, WS);
  const live = new Set((after.research?.brief ?? []).map((q) => q.id));
  const orphans = (after.research?.strategy ?? []).filter((a) => a.answers && !live.has(a.answers));
  console.log(`\norphaned angles after reconcile: ${orphans.length ? orphans.map((a) => a.id).join(', ') : 'none'}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
