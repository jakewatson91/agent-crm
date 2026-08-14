/**
 * Assertions for choosing which problem a message argues.
 *
 * The bug this pins: the step that picks the problem was assigning ones the
 * account's own facts contradict. A subscription streaming service was handed
 * "ads pay you a fixed amount per view", and because the drafter is told to
 * build its question from that problem and no other, it refused rather than
 * write the message. Everything downstream behaved correctly; the wrong answer
 * was chosen before any of it ran.
 *
 * The fix is a citation. The pick has to name the numbered fact that shows the
 * problem is real, the way the drafter has to quote the phrase behind each fact
 * it cites. We cannot check that the cited fact truly shows the problem, but
 * requiring the number makes the model go and look for one, and an answer that
 * cannot produce it is thrown away rather than acted on.
 *
 * Why this matters more than it looks: no angle is a soft failure. The drafter
 * falls back to reading the whole menu itself under STEP 2, which demands
 * evidence and stops when there is none. A wrong angle is a hard failure, since
 * the drafter is forbidden from substituting a different problem.
 */
import { pickDraftAngle } from '../packages/tools/src/pick_angle.ts';

let fail = 0;
function ok(name: string, cond: boolean, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `\n        ${detail}`}`);
  if (!cond) fail++;
}

const sb = {} as never;
const WS = 'ws-test';
const base = {
  model: 'test/model',
  account_name: 'Test Co',
  facts: [
    { predicate: 'business_model', object_text: 'subscription only, no advertising' },
    { predicate: 'recent_launch', object_text: 'launched a new season weekly' },
  ],
  pain_points: ['ads pay a fixed amount per view while delivery grows', 'popular titles get watched at the same time'],
  templates: [{ id: 't1', angle: 'cost per view against a fixed yield', enabled: true }],
};

const answer = (o: Record<string, unknown>) => async () => JSON.stringify(o);

async function main() {
  console.log('\nA pick has to point at the fact that shows the problem:');

  let d = await pickDraftAngle(sb, WS, base, answer({ problem: 1, evidence: 1, why: 'names their model', same_argument: [1] }));
  ok('a pick citing a real fact is kept', d.reason === 'picked' && d.choice?.problem === base.pain_points[0], JSON.stringify(d));
  ok('and it still reports which example argues the same thing', d.choice?.withheld_template_ids.join() === 't1', JSON.stringify(d.choice));

  d = await pickDraftAngle(sb, WS, base, answer({ problem: 1, why: 'feels right', same_argument: [] }));
  ok('a pick with no fact behind it is thrown away', d.choice === null && d.reason === 'no_evidence', JSON.stringify(d));

  d = await pickDraftAngle(sb, WS, base, answer({ problem: 1, evidence: 99, why: 'cited a fact that does not exist', same_argument: [] }));
  ok('a fact number out of range is thrown away', d.choice === null && d.reason === 'no_evidence', JSON.stringify(d));

  d = await pickDraftAngle(sb, WS, base, answer({ problem: 1, evidence: 0, why: 'could not find one', same_argument: [] }));
  ok('zero means it could not find one, so no angle', d.choice === null && d.reason === 'no_evidence', JSON.stringify(d));

  console.log('\nThrowing the pick away is a SOFT failure, and has to stay one:');
  ok('no angle is reported separately from a broken call',
    (await pickDraftAngle(sb, WS, base, answer({ problem: 0, evidence: 0, why: 'none fit', same_argument: [] }))).reason === 'no_problem_fits');
  ok('an unreadable answer is its own reason',
    (await pickDraftAngle(sb, WS, base, async () => 'not json')).reason === 'unparseable');
  ok('a call that throws is its own reason',
    (await pickDraftAngle(sb, WS, base, async () => { throw new Error('down'); })).reason === 'llm_error');

  console.log('\nThe facts have to be numbered, or a citation cannot refer to one:');
  let seen = '';
  await pickDraftAngle(sb, WS, base, async (text) => { seen = text; return JSON.stringify({ problem: 1, evidence: 1, why: '', same_argument: [] }); });
  ok('facts are numbered in the prompt', /^1\. business_model/m.test(seen), seen.slice(0, 200));
  ok('and the answer is asked for the number', /"evidence"/.test(seen) === false, 'the shape belongs in the system prompt, not the facts');

  console.log(fail === 0 ? '\nOK: pick-angle assertions passed\n' : `\nFAILED: ${fail} assertion(s)\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
