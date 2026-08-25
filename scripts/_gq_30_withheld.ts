/**
 * Withholding a question from the planner is the entire enforcement — there is no
 * switch anywhere that says "do not search for this", only a question the planner
 * is never shown. Two things have to hold for that to work, and both are the
 * planner's behaviour rather than the code's, so they need a real model:
 *
 *   1. It plans no angle for a question it cannot see.
 *   2. It names the question every angle serves. `coerceAngle` now DROPS an angle
 *      that does not, because an unattributed angle spends forever and appears in
 *      no question's record — and because arriving with no question is the one way
 *      a withheld question could get an angle anyway. If the model routinely
 *      omitted `answers`, that rule would empty the strategy instead.
 *
 * SPENDS: 3 planner calls (deepseek-v4-pro), no Exa.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
import { getPolicy, resolveBrief, PAIN_QUESTION, planResearchAngles, type PlannerContext } from '@agent-crm/tools';

const WS = process.env.GQ_WS ?? 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const RUNS = Number(process.argv[2] ?? 3);

(async () => {
  const sb = createServerClient();
  const policy = await getPolicy(sb as any, WS);
  const w = (await sb.from('workspaces').select('about, icp').eq('id', WS).maybeSingle()).data as any;
  const searchable = resolveBrief(policy).filter((q) => q.id !== PAIN_QUESTION.id);

  // Stand in for a question the record has ruled unsearchable.
  const withheld = searchable[0]!;
  const shown = searchable.filter((q) => q.id !== withheld.id);
  console.log(`withheld: ${withheld.id}`);
  console.log(`shown:    ${shown.map((q) => q.id).join(', ')}\n`);

  const base: PlannerContext = {
    about: (w?.about as string) ?? '',
    icp: JSON.stringify(w?.icp ?? {}).slice(0, 1500),
    value_props: policy.drafter?.value_props ?? [],
    pain_points: policy.drafter?.pain_points ?? [],
    guidance: policy.research?.guidance ?? '',
    always_include: policy.research?.always_include ?? [],
    social_domains: policy.research?.social_domains ?? [],
    max_age_days: policy.research?.max_age_days,
    previous: policy.research?.strategy ?? [],
    records: [],
  };

  let plannedForWithheld = 0;
  let unattributed = 0;
  let fellToBaseline = 0;
  for (let i = 1; i <= RUNS; i++) {
    const { angles, source, error } = await planResearchAngles(sb, WS, { ...base, brief: shown });
    if (source === 'baseline') { fellToBaseline++; console.log(`run ${i} FELL BACK: ${error}`); }
    const forWithheld = angles.filter((a) => a.answers === withheld.id);
    const noQuestion = angles.filter((a) => !a.answers);
    plannedForWithheld += forWithheld.length;
    unattributed += noQuestion.length;
    console.log(`run ${i} [${source}] ${angles.length} angles`);
    for (const a of angles) console.log(`    ${a.id.padEnd(26)} answers=${a.answers ?? '(NONE)'}  [${a.domain_scope}]`);
    const covered = new Set(angles.map((a) => a.answers));
    console.log(`    questions covered: ${shown.filter((q) => covered.has(q.id)).length}/${shown.length}`);
  }

  console.log(`\nangles planned for the withheld question: ${plannedForWithheld}/${RUNS} runs  ${plannedForWithheld === 0 ? 'PASS' : 'FAIL'}`);
  console.log(`angles that survived with no question:    ${unattributed}  ${unattributed === 0 ? 'PASS' : 'FAIL'}`);
  console.log(`planner runs that fell back to baseline:  ${fellToBaseline}/${RUNS}  ${fellToBaseline === 0 ? 'PASS' : 'FAIL — requiring answers is emptying the strategy'}`);
})();
