// Regenerate + persist Sudden's angles now that social_domains is cleared and the
// planner can see what each angle bought. Not the 14-day cycle: the currently
// persisted set still contains a social angle that buildAngleRequest now skips,
// which leaves technical_leader with no search at all until this runs.
//
// Same two calls the settings "Regenerate" button makes. ensureResearchBrief is
// deliberately NOT called: the brief is fine, every angle id below already points
// at a live question, and regenerating questions is a bigger change than this is.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
import { generateResearchStrategy, persistResearchStrategy } from '@agent-crm/tools';

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

async function main() {
  const sb = createServerClient();
  const { angles, source, error } = await generateResearchStrategy(sb, WS);
  console.log(`source=${source} error=${error ?? 'none'}`);
  for (const a of angles) {
    console.log(`  ${a.id} [${a.domain_scope}] answers=${a.answers ?? '-'} recency=${a.recency_days ?? '-'}`);
    console.log(`      ${a.query_template}`);
  }
  if (source !== 'ai') {
    console.log('\nplanner fell back to baseline — NOT persisting, the current set is better than neutral');
    return;
  }
  const served = new Set(angles.map((a) => a.answers).filter(Boolean));
  if (!served.has('monetization_model') || angles.some((a) => a.domain_scope === 'social')) {
    console.log('\nregression (lost monetization_model, or a social angle came back) — NOT persisting');
    return;
  }
  await persistResearchStrategy(sb, WS, angles);
  console.log('\npersisted to workspaces.policy.research.strategy');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
