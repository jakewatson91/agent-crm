/**
 * Does the brief get BETTER or WORSE as we feed the planner more config?
 *
 * Runs the brief planner three times per input set and reports what came out.
 * The question that matters: does a plain reading of About alone produce the
 * broad "how much do they serve" question, and is it stable run to run?
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { planResearchBrief, getPolicy, type BriefContext } from '@agent-crm/tools';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = process.env.GQ_WS ?? 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const RUNS = Number(process.argv[2] ?? 3);

(async () => {
  const w = (await sb.from('workspaces').select('about, icp').eq('id', WS).maybeSingle()).data as any;
  const policy = await getPolicy(sb as any, WS);
  const about = (w.about ?? '').trim();

  const full: BriefContext = {
    about,
    icp: JSON.stringify(w.icp ?? {}).slice(0, 1500),
    value_props: (policy.drafter?.value_props ?? []).filter(Boolean),
    pain_points: (policy.drafter?.pain_points ?? []).filter(Boolean),
    guidance: (policy.research?.guidance ?? '').trim(),
    always_include: (policy.research?.always_include ?? []).filter(Boolean),
  };
  const aboutOnly: BriefContext = { about, icp: '', value_props: [], pain_points: [], guidance: '', always_include: [] };

  const sets: Array<[string, BriefContext]> = [
    ['ABOUT ONLY', aboutOnly],
    ['EVERYTHING (about + icp + value_props + pains + guidance + always_include)', full],
  ];

  for (const [label, ctx] of sets) {
    console.log(`\n${'='.repeat(78)}\n${label}\n${'='.repeat(78)}`);
    const idSets: string[][] = [];
    for (let r = 0; r < RUNS; r++) {
      const { questions, source } = await planResearchBrief(sb, WS, ctx);
      idSets.push(questions.map((q) => q.id));
      console.log(`\n  run ${r + 1} (${source}) — ${questions.length} questions`);
      for (const q of questions) console.log(`    [${q.id}] ${q.question.slice(0, 118)}`);
    }
    // Stability: how many ids show up in every run.
    const counts = new Map<string, number>();
    for (const ids of idSets) for (const id of new Set(ids)) counts.set(id, (counts.get(id) ?? 0) + 1);
    const inAll = [...counts.entries()].filter(([, c]) => c === RUNS).map(([id]) => id);
    console.log(`\n  ids appearing in ALL ${RUNS} runs: ${inAll.length ? inAll.join(', ') : '(none)'}`);
    console.log(`  distinct ids seen across runs: ${counts.size}`);
  }
})();
