/**
 * Does a regeneration correct the brief from evidence, or does it just delete
 * whatever looks unproductive?
 *
 * Feeds the planner a track record with three deliberately different shapes and
 * checks it reads them apart:
 *   A. lots of pages seen, almost none kept   -> bad SEARCH. Question must survive.
 *   B. plenty of facts, never used in a message -> genuinely dead. May be dropped.
 *   C. barely any pages seen yet              -> unproven. Must survive.
 *
 * Getting A wrong is the expensive failure: it deletes a good question because
 * someone wrote a bad query for it, and the question's whole track record with it.
 *
 * No Exa. One planner call per run.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { planResearchBrief, getPolicy, resolveBrief, type QuestionRecord } from '@agent-crm/tools';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = process.env.GQ_WS ?? 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const RUNS = Number(process.argv[2] ?? 2);

(async () => {
  const w = (await sb.from('workspaces').select('about, icp').eq('id', WS).maybeSingle()).data as any;
  const policy = await getPolicy(sb as any, WS);
  const brief = resolveBrief(policy).filter((q) => q.id !== 'pain');
  if (brief.length < 3) { console.log('need at least 3 questions in the brief'); return; }

  const [badSearch, dead, unproven, ...rest] = brief;
  const records: QuestionRecord[] = [
    { id: badSearch!.id, fetched: 220, kept: 4, facts: 2, dated: 1, used: 0, kind: 'state' },      // A
    { id: dead!.id, fetched: 180, kept: 90, facts: 140, dated: 70, used: 0, kind: 'state' },       // B
    { id: unproven!.id, fetched: 6, kept: 2, facts: 3, dated: 2, used: 0, kind: 'state' },         // C
    ...rest.map((q) => ({ id: q.id, fetched: 150, kept: 60, facts: 70, dated: 35, used: 9, kind: 'state' as const })),
  ];

  console.log('TRACK RECORD FED IN:');
  console.log(`  A bad-search : ${badSearch!.id}   220 seen, 4 kept (2%), 2 facts, 0 used   -> must SURVIVE`);
  console.log(`  B dead       : ${dead!.id}   180 seen, 90 kept, 140 facts, 0 used   -> may be dropped`);
  console.log(`  C unproven   : ${unproven!.id}   6 seen, 2 kept, 3 facts, 0 used     -> must SURVIVE`);
  for (const q of rest) console.log(`  earning      : ${q.id}   150 seen, 60 kept, 70 facts, 9 used   -> must SURVIVE`);

  const ctx = {
    about: (w.about ?? '').trim(),
    icp: JSON.stringify(w.icp ?? {}).slice(0, 1500),
    value_props: (policy.drafter?.value_props ?? []).filter(Boolean),
    pain_points: (policy.drafter?.pain_points ?? []).filter(Boolean),
    guidance: (policy.research?.guidance ?? '').trim(),
    always_include: (policy.research?.always_include ?? []).filter(Boolean),
  };

  let aSurvived = 0, bDropped = 0, cSurvived = 0;
  for (let r = 0; r < RUNS; r++) {
    const { questions } = await planResearchBrief(sb, WS, ctx, { previous: brief, records });
    const ids = new Set(questions.map((q) => q.id));
    const a = ids.has(badSearch!.id), b = ids.has(dead!.id), c = ids.has(unproven!.id);
    if (a) aSurvived++;
    if (!b) bDropped++;
    if (c) cSurvived++;
    console.log(`\n  run ${r + 1}: ${questions.length} questions -> ${questions.map((q) => q.id).join(', ')}`);
    console.log(`     A bad-search kept? ${a ? 'YES (correct)' : 'NO  <-- WRONG, deleted a good question'}`);
    console.log(`     B dead dropped?    ${!b ? 'yes' : 'no (kept — acceptable, it is a judgement call)'}`);
    console.log(`     C unproven kept?   ${c ? 'YES (correct)' : 'NO  <-- WRONG, judged too early'}`);
  }

  console.log(`\nover ${RUNS} runs: bad-search survived ${aSurvived}/${RUNS}, unproven survived ${cSurvived}/${RUNS}, dead dropped ${bDropped}/${RUNS}`);
  console.log(aSurvived === RUNS && cSurvived === RUNS
    ? 'GUARDRAILS HOLD — no question was deleted for having a bad search or too little data.'
    : 'GUARDRAIL FAILURE — a question was deleted that should have survived.');
})();
