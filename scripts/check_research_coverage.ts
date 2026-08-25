/**
 * Assertions for the three ways a research question could be silently abandoned.
 *
 * All three were found on the live workspace in one sitting, and all three have
 * the same consequence: a question the customer wants answered goes on looking
 * like a question that cannot be answered.
 *
 * 1. NOTHING SEARCHES FOR IT. There was a check for a search pointing at a
 *    question that no longer exists, and none for the reverse. The planner is
 *    explicitly allowed to leave a question uncovered when it judges no search
 *    would find the answer, so it can drop coverage and nothing says so. Found
 *    live: the question asking what a technical leader had said about delivery
 *    costs had no angle at all, and the search NAMED for it was filed as
 *    answering the new-launch question instead. Its record read near-zero, which
 *    the maintenance loop reads as a failing question and rewrites or drops —
 *    when nothing had ever looked.
 *
 * 2. YOU COULD SWITCH A SEARCH OFF BUT NOT ON. Angles regenerate on a timer and
 *    the only human decision carried across was `enabled: false`. So a search
 *    written by hand for an uncovered question was deleted at the next
 *    regeneration, and the question went straight back to having nothing buying
 *    pages for it. Pinning is the on switch.
 *
 * 3. A REWORDED QUESTION INHERITED THE OLD WORDING'S RECORD. Same bug the
 *    searches already had and fixed with `record_since`. Since the record is
 *    what decides whether a question is rewritten again or dropped, widening a
 *    question that had been failing hands the new version the old version's
 *    failure and it is thrown away before it is asked once.
 *
 * The subtle half of 3 is that BOTH numbers have to reset together. Resetting
 * the answers a question keeps while leaving the pages it cost produces high
 * cost against zero return, which is the exact shape that reads as "this search
 * cannot work" — so a half fix is worse than none.
 */
import { uncoveredQuestions, carryPinnedAngles } from '../packages/tools/src/research_strategy.ts';
import { stampQuestionChanges, foldFetchedByQuestion, type RunMarker } from '../packages/tools/src/research_brief.ts';
import type { ResearchAngle, BriefQuestion, WorkspacePolicy } from '../packages/tools/src/policy.ts';

let fail = 0;
function ok(name: string, cond: boolean, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `\n        ${detail}`}`);
  if (!cond) fail++;
}

const q = (id: string, question = `what about ${id}?`, extra: Partial<BriefQuestion> = {}): BriefQuestion =>
  ({ id, label: id, question, ...extra });
const angle = (id: string, answers?: string, extra: Partial<ResearchAngle> = {}): ResearchAngle =>
  ({ id, label: id, query_template: `{entity} ${id}`, domain_scope: 'news', ...(answers ? { answers } : {}), ...extra });

console.log('\nA question nothing searches for is reported:');
{
  const policy = {
    research: {
      brief: [q('technical_leader'), q('recent_launch')],
      // This is Sudden's real shape: the search named for the leader question
      // is filed as answering a different one.
      strategy: [angle('tech_leader_blog', 'recent_launch'), angle('launches_news', 'recent_launch')],
    },
  } as WorkspacePolicy;
  ok('the uncovered question is named', uncoveredQuestions(policy).join(',') === 'technical_leader',
    `got ${JSON.stringify(uncoveredQuestions(policy))}`);
}
{
  const policy = {
    research: { brief: [q('a'), q('b')], strategy: [angle('s1', 'a'), angle('s2', 'b')] },
  } as WorkspacePolicy;
  ok('a fully covered brief reports nothing', uncoveredQuestions(policy).length === 0);
}
{
  // A search switched off is not coverage. This is how a question gets
  // abandoned by a human rather than by the planner, and it should read the same.
  const policy = {
    research: { brief: [q('a')], strategy: [angle('s1', 'a', { enabled: false })] },
  } as WorkspacePolicy;
  ok('a disabled search does not count as coverage', uncoveredQuestions(policy).join(',') === 'a');
}
{
  // A second, live question on purpose: resolveBrief falls back to the neutral
  // baseline when every stored question is off, and then the baseline's five
  // questions are legitimately uncovered. That fallback is correct, it just
  // makes a one-question workspace the wrong shape to test this with.
  const policy = {
    research: {
      brief: [q('off_one', 'x', { enabled: false }), q('live_one')],
      strategy: [angle('s1', 'live_one')],
    },
  } as WorkspacePolicy;
  ok('a question the human switched off is not reported as neglected', uncoveredQuestions(policy).length === 0,
    `switching a question off is a decision, not a gap — got ${JSON.stringify(uncoveredQuestions(policy))}`);
}

console.log('\nA pinned search survives the planner replacing everything:');
{
  const previous = [angle('hand_written', 'technical_leader', { pinned: true, query_template: '{entity} CEO interview delivery cost' })];
  const planned = [angle('launches_news', 'recent_launch')];
  const out = carryPinnedAngles(planned, previous);
  ok('it is still there', out.some((a) => a.id === 'hand_written'));
  ok('its query is untouched', out.find((a) => a.id === 'hand_written')?.query_template === '{entity} CEO interview delivery cost');
  ok('the planned angles are kept too', out.some((a) => a.id === 'launches_news'));
}
{
  // The planner reusing the id is exactly what a pin exists to refuse.
  const previous = [angle('leader', 'technical_leader', { pinned: true, query_template: 'MINE' })];
  const planned = [angle('leader', 'recent_launch', { query_template: 'PLANNER REWROTE IT' })];
  const out = carryPinnedAngles(planned, previous);
  ok('the pin wins over a planner rewrite of the same id',
    out.filter((a) => a.id === 'leader').length === 1 && out.find((a) => a.id === 'leader')?.query_template === 'MINE');
}
{
  const planned = [angle('a', 'q1')];
  ok('no pins means the planner output is returned untouched',
    JSON.stringify(carryPinnedAngles(planned, [angle('b', 'q2')])) === JSON.stringify(planned));
}

console.log('\nRewording a question restarts its record; tidying it does not:');
const NOW = '2026-08-25T12:00:00.000Z';
{
  const prev = [q('leader', 'What has a TECHNICAL leader said about delivery cost?')];
  const next = [q('leader', 'What has ANYONE at the company said about delivery cost?')];
  ok('a widened question starts over', stampQuestionChanges(next, prev, NOW)[0]!.words_changed_at === NOW,
    'it would otherwise be judged on the numbers of the wording it replaced');
}
{
  const prev = [q('leader', 'same words', { words_changed_at: '2026-08-01T00:00:00.000Z' })];
  const next = [q('leader', 'same words', { label: 'A NEW LABEL', why: 'a new reason' })];
  ok('relabelling carries the old stamp forward',
    stampQuestionChanges(next, prev, NOW)[0]!.words_changed_at === '2026-08-01T00:00:00.000Z',
    'restarting a record for a tidy-up means a record never accumulates');
}
{
  ok('a brand new question starts now', stampQuestionChanges([q('fresh')], [], NOW)[0]!.words_changed_at === NOW);
}

console.log('\nBOTH halves of the record reset together, or the fix makes it worse:');
{
  const angles = [angle('s1', 'leader')];
  const marker = (at: string, payload: Record<string, unknown>): RunMarker =>
    ({ created_at: at, payload } as RunMarker);
  const CHANGED = Date.parse('2026-08-20T00:00:00.000Z');
  const markers = [
    marker('2026-08-01T00:00:00.000Z', { per_question_fetched: { leader: 200 } }),  // old wording
    marker('2026-08-22T00:00:00.000Z', { per_question_fetched: { leader: 5 } }),    // new wording
  ];
  const withFloor = foldFetchedByQuestion(markers, angles, 0, new Map([['leader', CHANGED]]));
  ok('pages bought under the old wording are not charged to the new one', withFloor.leader === 5,
    `got ${withFloor.leader} — 200 of those pages were bought for a question that no longer exists`);

  const noFloor = foldFetchedByQuestion(markers, angles, 0, new Map());
  ok('and without a floor the old pages still count (so the Map is doing the work)', noFloor.leader === 205);

  // The same floor has to reach the per-ANGLE shape, which is what older run
  // markers carry.
  const viaAngle = foldFetchedByQuestion(
    [marker('2026-08-01T00:00:00.000Z', { per_angle_fetched: { s1: 200 } }),
     marker('2026-08-22T00:00:00.000Z', { per_angle_fetched: { s1: 7 } })],
    angles, 0, new Map([['leader', CHANGED]]),
  );
  ok('the floor applies to per-angle run markers too', viaAngle.leader === 7,
    `got ${viaAngle.leader} — older markers record per angle, and they would sneak the old pages back in`);
}

console.log(fail ? `\n${fail} FAILED\n` : '\nAll research-coverage assertions pass.\n');
process.exit(fail ? 1 : 0);
