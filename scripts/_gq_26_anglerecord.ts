/**
 * Does an angle's own track record survive contact with the planner?
 *
 * Three runs, no persist. What matters is not that the output looks good once:
 *  - linkedin_leadership (183 fetched, 0 kept) must not come back as it was.
 *  - monetization_revenue_news (24 fetched, 17 kept, 71%) must SURVIVE. It is the
 *    best-performing angle in the workspace and a planner run without the record
 *    dropped it entirely, which is the failure this feature exists to stop.
 *  - every brief question that had a working angle must still have one.
 *
 * Run: pnpm tsx scripts/_gq_26_anglerecord.ts
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
import { generateResearchStrategy } from '@agent-crm/tools';

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const RUNS = 3;

async function main() {
  const sb = createServerClient();
  for (let i = 1; i <= RUNS; i++) {
    const { angles, source, error } = await generateResearchStrategy(sb, WS);
    console.log(`\n=== run ${i} — source=${source} error=${error ?? 'none'} ===`);
    for (const a of angles) {
      console.log(`  ${a.id} [${a.domain_scope}] answers=${a.answers ?? '-'} recency=${a.recency_days ?? '-'}`);
      console.log(`      ${a.query_template}`);
    }
    const served = new Set(angles.map((a) => a.answers).filter(Boolean));
    console.log(`  questions served: ${[...served].join(', ')}`);
    console.log(`  linkedin angle back? ${angles.some((a) => a.domain_scope === 'social') ? 'YES — BAD' : 'no'}`);
    console.log(`  monetization kept?  ${served.has('monetization_model') ? 'yes' : 'NO — REGRESSION'}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
