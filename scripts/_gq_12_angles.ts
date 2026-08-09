/**
 * Regenerate the search strategy now that the planner knows the brief. DRY RUN
 * by default. Shows each angle with the brief question it says it serves, so a
 * angle that answers nothing is visible before it spends anything.
 *
 * Usage: pnpm tsx scripts/_gq_12_angles.ts [--apply]
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { generateResearchStrategy, persistResearchStrategy, resolveBrief, getPolicy } from '@agent-crm/tools';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const APPLY = process.argv.includes('--apply');
const WS = process.env.GQ_WS ?? 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

(async () => {
  const policy = await getPolicy(sb as any, WS);
  const brief = resolveBrief(policy);
  console.log('BRIEF QUESTIONS:');
  for (const q of brief) console.log(`  ${q.id}`);

  console.log('\n--- CURRENT angles ---');
  for (const a of policy.research?.strategy ?? []) {
    console.log(`  ${String(a.id).padEnd(20)} ${String(a.domain_scope).padEnd(9)} ${String(a.recency_days ?? 'none').padStart(4)}d  answers=${a.answers ?? '(none)'}`);
    console.log(`      ${a.query_template}`);
  }

  const { angles, source, error } = await generateResearchStrategy(sb as any, WS);
  console.log(`\n--- REGENERATED angles (source=${source}${error ? `, error=${error}` : ''}) ---`);
  const qIds = new Set(brief.map((q) => q.id));
  for (const a of angles) {
    const flag = a.answers ? (qIds.has(a.answers) ? 'ok ' : 'BAD') : 'NONE';
    console.log(`  [${flag}] ${String(a.id).padEnd(20)} ${String(a.domain_scope).padEnd(9)} ${String(a.recency_days ?? 'none').padStart(4)}d  answers=${a.answers ?? '(none)'}`);
    console.log(`         ${a.query_template}`);
  }
  const unserved = [...qIds].filter((q) => !angles.some((a) => a.answers === q));
  if (unserved.length) console.log(`\n  questions with NO angle (fine when no search would find them): ${unserved.join(', ')}`);

  if (APPLY) {
    await persistResearchStrategy(sb as any, WS, angles);
    console.log('\nPERSISTED to policy.research.strategy');
  } else {
    console.log('\n(dry run — nothing written. --apply to persist)');
  }
})();
