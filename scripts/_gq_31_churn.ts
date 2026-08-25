/**
 * Loosening failedAngles from "kept zero" to "under one answer per fair trial"
 * makes regeneration fire more often. Every regeneration puts the workspace's
 * WORKING angle in front of the planner again, and the only thing protecting it
 * is a line in the prompt telling the model not to reword a working query.
 *
 * If that does not hold, the fix costs more than the waste it removes.
 *
 * SPENDS: 3 planner calls (deepseek-v4-pro), no Exa.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
import { getPolicy, questionsWorthSearching, planResearchAngles, type PlannerContext, type AngleRecord } from '@agent-crm/tools';

const WS = process.env.GQ_WS ?? 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const RUNS = Number(process.argv[2] ?? 3);

(async () => {
  const sb = createServerClient();
  const policy = await getPolicy(sb as any, WS);
  const w = (await sb.from('workspaces').select('about, icp').eq('id', WS).maybeSingle()).data as any;
  const previous = policy.research?.strategy ?? [];

  // The live shape from the scorecard before the denominator was fixed: one angle
  // clearly earning, two clearly not.
  const records: AngleRecord[] = [
    { id: 'recent_launches_news', fetched: 199, kept: 84 },
    { id: 'cdn_provider_mentions', fetched: 179, kept: 11 },
    { id: 'linkedin_leadership', fetched: 264, kept: 1 },
    { id: 'customer_case_studies', fetched: 216, kept: 1 },
  ];
  const healthy = previous.find((a) => a.id === 'recent_launches_news');
  const failing = previous.filter((a) => ['linkedin_leadership', 'customer_case_studies'].includes(a.id));
  console.log(`working angle:  ${healthy?.id} = ${healthy?.query_template} [${healthy?.domain_scope}]`);
  for (const f of failing) console.log(`failing angle:  ${f.id} = ${f.query_template} [${f.domain_scope}]`);

  const base: PlannerContext = {
    about: (w?.about as string) ?? '',
    icp: JSON.stringify(w?.icp ?? {}).slice(0, 1500),
    value_props: policy.drafter?.value_props ?? [],
    pain_points: policy.drafter?.pain_points ?? [],
    guidance: policy.research?.guidance ?? '',
    always_include: policy.research?.always_include ?? [],
    social_domains: policy.research?.social_domains ?? [],
    max_age_days: policy.research?.max_age_days,
    brief: questionsWorthSearching(policy, []),
    previous,
    records,
  };

  let survived = 0, failingRewritten = 0;
  for (let i = 1; i <= RUNS; i++) {
    const { angles, source } = await planResearchAngles(sb, WS, base);
    const now = angles.find((a) => a.id === healthy?.id);
    const same = !!now && now.query_template === healthy?.query_template && now.domain_scope === healthy?.domain_scope;
    if (same) survived++;
    const rewrites = failing.filter((f) => {
      const n = angles.find((a) => a.id === f.id);
      return !n || n.query_template !== f.query_template || n.domain_scope !== f.domain_scope;
    }).length;
    failingRewritten += rewrites;
    console.log(`\nrun ${i} [${source}] — working angle ${same ? 'UNCHANGED' : 'CHANGED'}, ${rewrites}/${failing.length} failing angles rewritten`);
    if (!same) console.log(`    now: ${now ? `${now.query_template} [${now.domain_scope}]` : '(dropped entirely)'}`);
  }

  console.log(`\nworking angle survived untouched: ${survived}/${RUNS}  ${survived === RUNS ? 'PASS' : 'FAIL — regeneration churn damages what works'}`);
  console.log(`failing angles actually rewritten: ${failingRewritten}/${RUNS * failing.length}  ${failingRewritten === RUNS * failing.length ? 'PASS' : 'the record is not driving the rewrite'}`);
})();
