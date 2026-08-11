/**
 * The planner fell back to BASELINE_ANGLES twice in 15 runs while I was proving
 * other things. With regeneration now firing on evidence rather than a 14-day
 * timer, a 13% failure rate lands often. Two very different causes:
 *
 *   'planner returned no valid angles' -> coerceAngle rejected everything, which
 *      would mean requiring `answers` is the cause and I made this worse.
 *   anything else                      -> the LLM call itself, pre-existing.
 *
 * SPENDS: planner calls (deepseek-v4-pro), no Exa.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
import { getPolicy, questionsWorthSearching, planResearchAngles, type PlannerContext } from '@agent-crm/tools';

const WS = process.env.GQ_WS ?? 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const RUNS = Number(process.argv[2] ?? 6);

(async () => {
  const sb = createServerClient();
  const policy = await getPolicy(sb as any, WS);
  const w = (await sb.from('workspaces').select('about, icp').eq('id', WS).maybeSingle()).data as any;
  const base: PlannerContext = {
    about: (w?.about as string) ?? '', icp: JSON.stringify(w?.icp ?? {}).slice(0, 1500),
    value_props: policy.drafter?.value_props ?? [], pain_points: policy.drafter?.pain_points ?? [],
    guidance: policy.research?.guidance ?? '', always_include: policy.research?.always_include ?? [],
    social_domains: policy.research?.social_domains ?? [], max_age_days: policy.research?.max_age_days,
    brief: questionsWorthSearching(policy, []), previous: policy.research?.strategy ?? [], records: [],
  };
  const errors: string[] = [];
  for (let i = 1; i <= RUNS; i++) {
    const { angles, source, error } = await planResearchAngles(base);
    console.log(`run ${i}: ${source} ${angles.length} angles${error ? `  ERROR: ${error}` : ''}`);
    if (error) errors.push(error);
  }
  const coerce = errors.filter((e) => e.includes('no valid angles')).length;
  console.log(`\nfallbacks: ${errors.length}/${RUNS}`);
  console.log(`  caused by coerceAngle rejecting everything: ${coerce}`);
  console.log(`  caused by the LLM call itself:              ${errors.length - coerce}`);
})();
