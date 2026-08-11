/**
 * Assertions for the research brief and for "which version of a fact is current".
 *
 * No test runner in this repo, so this stands in as the regression guard for two
 * things that have each broken in production.
 *
 * 1. currentFactRows — reading a supersede chain backwards. A rescore writes the
 *    NEW row carrying supersedes=<old id>, so the row whose own `supersedes` is
 *    null is the FIRST-EVER value and never moves again. Filtering on it returns
 *    the oldest score, not the newest. That shipped three separate times: the
 *    agent's book projection, the stale-rescore scan, and the research
 *    dispatcher, where it tiered 89% of accounts on a stale number and sent 57
 *    dead accounts to daily research while visiting genuinely hot ones monthly.
 *    It kept coming back because every caller re-derived it by hand.
 *
 * 2. resolveBrief — the questions every research stage shares. A workspace that
 *    has configured nothing must still get a working, vertical-neutral set, and
 *    the pain question must be impossible to switch off: a page reporting that a
 *    company's service buckled under load answers no other question, and it is
 *    the most valuable page there is.
 *
 * Run: tsx scripts/check_research_brief.ts   (exits non-zero on failure)
 */
import { currentFactRows } from '../packages/tools/src/reads.ts';
import {
  resolveBrief, BASELINE_BRIEF, PAIN_QUESTION, sysPrompt, briefInputHash,
  earnsItsSearches, unreachableQuestions, recordReading, foldFetchedByQuestion, carryQuestionOffSwitch, UNREACHABLE_PAGES,
} from '../packages/tools/src/research_brief.ts';
import type { WorkspacePolicy } from '../packages/tools/src/policy.ts';

let fail = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
}

const row = (id: string, supersedes: string | null, observed_at: string, value: string) =>
  ({ id, supersedes, observed_at, value, key: 'k' });

console.log('\nA supersede chain reads newest-first, not oldest-first:');
{
  // b supersedes a, c supersedes b. Only c is current.
  const rows = [
    row('a', null, '2026-01-01T00:00:00Z', 'first'),
    row('b', 'a', '2026-02-01T00:00:00Z', 'second'),
    row('c', 'b', '2026-03-01T00:00:00Z', 'third'),
  ];
  const cur = currentFactRows(rows, (r) => r.key);
  eq('the newest value wins, not the one with a null supersedes', cur.get('k')?.value, 'third');
  eq('exactly one row survives per key', cur.size, 1);
}

console.log('\nA single unsuperseded row is itself current:');
{
  const rows = [row('a', null, '2026-01-01T00:00:00Z', 'only')];
  eq('one row in, that row out', currentFactRows(rows, (r) => r.key).get('k')?.value, 'only');
}

console.log('\nRows are separated by key, and chains do not leak across them:');
{
  const rows = [
    { id: 'a1', supersedes: null, observed_at: '2026-01-01T00:00:00Z', value: 'old-x', key: 'x' },
    { id: 'a2', supersedes: 'a1', observed_at: '2026-02-01T00:00:00Z', value: 'new-x', key: 'x' },
    { id: 'b1', supersedes: null, observed_at: '2026-01-01T00:00:00Z', value: 'only-y', key: 'y' },
  ];
  const cur = currentFactRows(rows, (r) => r.key);
  eq('x resolves to its newest', cur.get('x')?.value, 'new-x');
  eq('y is untouched by x\'s chain', cur.get('y')?.value, 'only-y');
}

console.log('\nWhen nothing supersedes anything, newest observed_at breaks the tie:');
{
  const rows = [
    row('a', null, '2026-01-01T00:00:00Z', 'older'),
    row('b', null, '2026-05-01T00:00:00Z', 'newer'),
  ];
  eq('newest wins', currentFactRows(rows, (r) => r.key).get('k')?.value, 'newer');
}

console.log('\nAn incomplete read cannot be silently trusted (documents the paging requirement):');
{
  // Caller paged badly and only handed over the older half of the chain. The
  // helper can only work with what it is given: it returns the newest row IT
  // SAW. This is why the dispatcher pages its score read instead of relying on
  // PostgREST's 1000-row default.
  const rows = [row('a', null, '2026-01-01T00:00:00Z', 'first')];
  eq('returns the newest of what it was given', currentFactRows(rows, (r) => r.key).get('k')?.value, 'first');
}

console.log('\nA workspace that configured nothing still gets a working brief:');
{
  const brief = resolveBrief({} as WorkspacePolicy);
  eq('falls back to the neutral baseline', brief.some((q) => q.id === BASELINE_BRIEF[0]!.id), true);
  eq('names no industry, metric or product category', /stream|video|cdn|saas|restaurant|freight/i.test(JSON.stringify(BASELINE_BRIEF)), false);
}

console.log('\nThe pain question can never be configured away:');
{
  eq('present on an empty policy', resolveBrief({} as WorkspacePolicy).some((q) => q.id === PAIN_QUESTION.id), true);
  const custom = { research: { brief: [{ id: 'only_thing', label: 'x', question: 'What do they sell?' }] } } as WorkspacePolicy;
  eq('appended to a fully custom brief', resolveBrief(custom).some((q) => q.id === PAIN_QUESTION.id), true);
  const already = { research: { brief: [{ id: PAIN_QUESTION.id, label: 'x', question: 'What hurts?' }] } } as WorkspacePolicy;
  eq('not duplicated when the brief already defines it', resolveBrief(already).filter((q) => q.id === PAIN_QUESTION.id).length, 1);
}

console.log('\nMalformed or disabled questions are dropped rather than trusted:');
{
  const p = { research: { brief: [
    { id: 'good', label: 'g', question: 'What did they ship recently?' },
    { id: 'off', label: 'o', question: 'Ignored.', enabled: false },
    { id: '', label: 'n', question: 'No id.' },
    { id: 'blank', label: 'b', question: '   ' },
  ] } } as WorkspacePolicy;
  const ids = resolveBrief(p).map((q) => q.id);
  eq('keeps the valid one', ids.includes('good'), true);
  eq('drops the disabled one', ids.includes('off'), false);
  eq('drops the one with no id', ids.includes(''), false);
  eq('drops the one with an empty question', ids.includes('blank'), false);
  eq('and still carries pain', ids.includes(PAIN_QUESTION.id), true);
}

// The brief planner asked what a technical leader had said "in the past year"
// while the workspace bins anything older than 90 days on arrival. The only pages
// that could answer it were thrown away before the gate saw them, so the search
// built for it read as broken across 183 pages when the question was never
// reachable. The strategy planner has been told the floor for a while; the planner
// that writes the questions the angles come from was not.
console.log('\nthe brief planner is told the floor it has to write inside:');
eq('the workspace floor reaches the prompt', sysPrompt(90).includes('more than 90 days ago'), true);
eq('a different floor changes the prompt', sysPrompt(30).includes('more than 30 days ago'), true);
eq('an unset floor still states a number', /more than \d+ days ago/.test(sysPrompt()), true);
eq('the rule names the windows it is banning', sysPrompt(90).includes('in the past year'), true);

// The floor shapes the questions, so moving it must re-open the brief. Without
// this, narrowing the floor leaves every question asking for a window the
// pipeline no longer reaches.
console.log('\nmoving the floor re-opens the brief:');
const baseCtx = { about: 'a', icp: '{}', value_props: [], pain_points: [], guidance: '', always_include: [] };
eq('same inputs hash the same', briefInputHash({ ...baseCtx, max_age_days: 90 }), briefInputHash({ ...baseCtx, max_age_days: 90 }));
eq('a moved floor hashes differently',
  briefInputHash({ ...baseCtx, max_age_days: 30 }) === briefInputHash({ ...baseCtx, max_age_days: 90 }), false);
eq('an unset floor is not the same as a set one',
  briefInputHash({ ...baseCtx }) === briefInputHash({ ...baseCtx, max_age_days: 90 }), false);

// The correction loop had no exit. A failing search is rewritten, the rewrite
// resets that angle's record, the fresh record reads "too early to judge", and
// the same question is searched for again forever — the brief planner cannot
// break the tie because it is told, correctly, that a low hit rate means the
// SEARCH is wrong and never the question. Measured live: a question rewritten
// twice, 264 pages bought, answered once.
console.log('\na question no search can answer is recognised, and only after several fair trials:');
{
  const r = (id: string, fetched: number, kept: number) => ({ id, fetched, kept });
  eq('3% of the pages it buys is the bar', earnsItsSearches(r('a', 100, 3)), true);
  eq('under it does not clear', earnsItsSearches(r('a', 100, 2)), false);
  eq('a working search clears it easily', earnsItsSearches(r('a', 199, 84)), true);
  eq('nothing bought, nothing to answer for', earnsItsSearches(r('a', 0, 0)), true);

  eq('the real failing question is caught', unreachableQuestions([r('technical_leader', 264, 1)]), ['technical_leader']);
  eq('zero answers over the same spend too', unreachableQuestions([r('a', UNREACHABLE_PAGES, 0)]), ['a']);
  // One lucky page used to make an angle permanently immune to correction,
  // because zero is the only number a single accident can move.
  eq('one lucky page does not buy immunity', unreachableQuestions([r('a', 216, 1)]), ['a']);
  eq('a question that has not been tried enough survives',
    unreachableQuestions([r('a', UNREACHABLE_PAGES - 1, 0)]), []);
  eq('one fair trial is not enough to condemn a question', unreachableQuestions([r('a', 40, 0)]), []);
  eq('a thin but real hit rate survives', unreachableQuestions([r('cdn_infrastructure', 179, 11)]), []);
  eq('a question nothing has been spent on is not condemned', unreachableQuestions([r('a', 0, 0)]), []);
}

// The angle planner had this exact hole and it was fixed there. The brief has
// carried it the whole time: coerceQuestion returns enabled:true on everything and
// the persist replaces the array, so a question a customer switched off came back
// on at the next regeneration, in every workspace.
console.log('\na human off switch on a question survives a regeneration:');
{
  const q = (id: string, question: string, enabled?: boolean) => ({ id, label: id, question, ...(enabled === undefined ? {} : { enabled }) });
  const before = [q('scale', 'How big?', false), q('moves', 'What changed?')];
  const replanned = [q('scale', 'How big are they now?', true), q('moves', 'What changed?', true), q('stack', 'What do they run on?', true)];
  const after = carryQuestionOffSwitch(replanned, before);
  eq('a question switched off stays off', after[0]!.enabled, false);
  eq('rewording it does not switch it back on', after[0]!.question, 'How big are they now?');
  eq('a question left alone stays on', after[1]!.enabled, true);
  eq('a brand-new question is on', after[2]!.enabled, true);
  eq('nothing switched off changes nothing', carryQuestionOffSwitch(replanned, []), replanned);
  eq('and the gate never sees the one that is off', resolveBrief({ research: { brief: after } } as WorkspacePolicy).map((x) => x.id), ['moves', 'stack', PAIN_QUESTION.id]);
}

// The verdict is only as good as its denominator, and the denominator was wrong.
// Live on Sudden: a question two days old read 216 pages bought against 1 answer,
// and would have been ruled unanswerable — the 216 were bought over a month by an
// angle that had been serving the question this one replaced.
console.log('\npages bought are counted against the question that was actually being asked:');
{
  const angles = [{ id: 'leader_search', answers: 'technical_leader' }];
  const m = (created_at: string, payload: Record<string, Record<string, number>>) => ({ created_at, payload });
  const FLOOR = Date.parse('2026-08-10T00:00:00Z');

  eq('a marker that names the question is believed',
    foldFetchedByQuestion([m('2026-08-11T00:00:00Z', { per_question_fetched: { technical_leader: 40 } })], angles, FLOOR),
    { technical_leader: 40 });
  // Both fields are written on every new marker; counting both would double it.
  eq('and its per-angle copy is not counted twice',
    foldFetchedByQuestion([m('2026-08-11T00:00:00Z', {
      per_question_fetched: { technical_leader: 40 }, per_angle_fetched: { leader_search: 40 },
    })], angles, FLOOR),
    { technical_leader: 40 });
  eq('an old marker is reconstructed through the angle',
    foldFetchedByQuestion([m('2026-08-10T06:00:00Z', { per_angle_fetched: { leader_search: 9 } })], angles, FLOOR),
    { technical_leader: 9 });
  eq('but not from before the question existed',
    foldFetchedByQuestion([m('2026-07-20T00:00:00Z', { per_angle_fetched: { leader_search: 216 } })], angles, FLOOR),
    {});
  eq('spend by an angle serving nothing is not attributed to anything',
    foldFetchedByQuestion([m('2026-08-11T00:00:00Z', { per_angle_fetched: { orphan: 50 } })], angles, FLOOR),
    {});
  // The whole point of writing it at the point of spend: it survives the rewrite.
  eq('a question keeps its history when its search is replaced',
    foldFetchedByQuestion([
      m('2026-08-11T00:00:00Z', { per_question_fetched: { technical_leader: 90 } }),
      m('2026-08-12T00:00:00Z', { per_question_fetched: { technical_leader: 70 } }),
    ], [{ id: 'a_completely_different_angle', answers: 'technical_leader' }], FLOOR),
    { technical_leader: 160 });
}

// Unsearchable is not worthless, and conflating the two deletes the best
// question in the brief. `pain` is the proof: nobody can search for it, and a
// page reporting a company's service buckling under load is the most valuable
// page research ever finds.
console.log('\nbeing unsearchable never takes a question out of the brief:');
{
  const p = { research: { brief: [{ id: 'technical_leader', label: 't', question: 'What has a leader there said?' }] } } as WorkspacePolicy;
  eq('the question is still read by the gate and the extractor',
    resolveBrief(p).map((q) => q.id), ['technical_leader', PAIN_QUESTION.id]);
}

// The planner that writes the questions has to be told the difference, or it
// reads "0 kept" as a search it should wait on and keeps the question pointed at
// a search that has stopped running.
console.log('\nthe brief planner is given the reading, not just the numbers:');
{
  const line = (fetched: number, kept: number, facts = 0) =>
    recordReading({ id: 'q', fetched, kept, facts, used: 0 });
  eq('a fresh question is protected', line(10, 0).includes('TOO EARLY TO JUDGE'), true);
  eq('a bad search is called a bad search', line(100, 1).includes('rewrite its query'), true);
  eq('an unreachable question is called unreachable', line(264, 1).includes('searching for this does not work'), true);
  eq('and it is told to keep it anyway', line(264, 1).includes('KEEP the question'), true);
  eq('a working question is left alone', line(199, 84, 5).includes('earning its place'), true);
}

console.log(fail === 0 ? '\nALL PASS\n' : `\n${fail} FAILED\n`);
process.exit(fail === 0 ? 0 : 1);
