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
 *
 * The second bug pinned here: for a workspace that has written down the parts of
 * a business it cannot serve, sorting the facts is a separate call that runs
 * first, and the facts it rules out are dropped before the pick is asked
 * anything. Asking one call to do both lost twice. The same prompt flagged five
 * facts on one run and none on the next, and a fact left in the prompt under a
 * "do not use this" label got used anyway. Nothing below tests the model's
 * judgement; it tests that a ruled-out fact is absent rather than forbidden, and
 * that dropping it does not knock the numbering out from under the pick.
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

/**
 * Answers whichever of the two calls is asking. A workspace with conditions
 * configured gets a sorting call first, which answers with a fact number and the
 * words it copied out of that fact, and then the pick, which never sees the
 * facts the sort ruled out.
 */
const answers = (pick: Record<string, unknown>, flags: Array<[number, string]> = []) =>
  async (_text: string, job?: 'scope' | 'pick') =>
    JSON.stringify(job === 'scope'
      ? { out_of_scope_facts: flags.map(([fact, quote]) => ({ fact, quote })) }
      : pick);

const answer = (o: Record<string, unknown>) => answers(o);

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

  console.log('\nA fact about a part we cannot serve never reaches the pick:');
  // The ruled-out fact is deliberately first. Dropping it renumbers everything
  // after it, and that renumbering is where the one-call version broke: it
  // handed the picker every fact, told it not to cite the ruled-out ones, and
  // then compared the number it answered with against numbers counted on a
  // different list.
  const scoped = {
    ...base,
    facts: [
      { id: 'f-ruled-out', predicate: 'rights_deal', object_text: 'signed the tournament rights, every match live' },
      { id: 'f-servable', predicate: 'catalogue_size', object_text: '4000 hours on demand' },
    ],
    out_of_scope: ['Their video is live only, with no on-demand catalogue.'],
  };

  const LIVE = 'every match live';
  let pickSeen = '';
  d = await pickDraftAngle(sb, WS, scoped, async (text, job) => {
    if (job === 'pick') pickSeen = text;
    return JSON.stringify(job === 'scope'
      ? { out_of_scope_facts: [{ fact: 1, quote: LIVE }] }
      : { problem: 1, evidence: 1, why: 'the catalogue', same_argument: [] });
  });
  ok('the ruled-out fact is not in the prompt that picks the problem', /rights_deal/.test(pickSeen) === false, pickSeen.slice(0, 300));
  ok('and the fact that survives is renumbered to 1', /^1\. catalogue_size/m.test(pickSeen), pickSeen.slice(0, 300));
  ok('a pick citing that renumbered fact is kept', d.reason === 'picked', JSON.stringify(d));
  ok('and the ruled-out fact comes back by id', d.out_of_scope_fact_ids.join() === 'f-ruled-out', JSON.stringify(d.out_of_scope_fact_ids));

  d = await pickDraftAngle(sb, WS, scoped, answers({ problem: 0, evidence: 0, why: 'nothing left', same_argument: [] }, [[1, LIVE]]));
  ok('the ids come back even when no problem was picked', d.out_of_scope_fact_ids.join() === 'f-ruled-out', JSON.stringify(d));

  d = await pickDraftAngle(sb, WS, scoped, answers({ problem: 1, evidence: 1, why: 'x', same_argument: [] }, [[1, LIVE], [2, '4000 hours']]));
  ok('an account with nothing sellable left is its own answer', d.choice === null && d.reason === 'all_facts_out_of_scope', JSON.stringify(d));
  ok('and is not reported as an account carrying no facts', d.reason !== 'no_facts', JSON.stringify(d));
  ok('and both ruled-out facts still come back', d.out_of_scope_fact_ids.length === 2, JSON.stringify(d.out_of_scope_fact_ids));

  // The id lookup that turns these numbers into fact ids runs outside the try
  // that catches a bad sort, so an unchecked number out of range is not a wrong
  // answer, it is a TypeError thrown through the middle of a drafter run.
  d = await pickDraftAngle(sb, WS, scoped, answers({ problem: 1, evidence: 1, why: 'x', same_argument: [] }, [[99, LIVE], [0, LIVE], [-1, LIVE]]));
  ok('fact numbers that do not exist are ignored rather than thrown',
    d.reason === 'picked' && d.out_of_scope_fact_ids.length === 0, JSON.stringify(d));

  d = await pickDraftAngle(sb, WS, scoped, answers({ problem: 1, evidence: 1, why: 'x', same_argument: [] }, [[1, LIVE], [1, 'match live'], [1, 'tournament']]));
  ok('the same fact named three times is one fact', d.out_of_scope_fact_ids.join() === 'f-ruled-out', JSON.stringify(d.out_of_scope_fact_ids));

  console.log('\nRuling a fact out takes words out of THAT fact, not a hunch about the company:');
  // This is the whole check. Without it the sort ruled out NHL.TV's freshest
  // fact, that the service moved to DAZN in nearly 200 countries, as being about
  // live sport. It says nothing about live sport. It is a message we can send.
  d = await pickDraftAngle(sb, WS, scoped, answers({ problem: 1, evidence: 1, why: 'x', same_argument: [] },
    [[2, 'they are a live sports company']]));
  ok('words that are not in the fact do not rule it out',
    d.reason === 'picked' && d.out_of_scope_fact_ids.length === 0, JSON.stringify(d));

  d = await pickDraftAngle(sb, WS, scoped, answers({ problem: 1, evidence: 1, why: 'x', same_argument: [] },
    [[2, LIVE]]));
  ok('and quoting a different fact does not rule this one out',
    d.out_of_scope_fact_ids.length === 0, JSON.stringify(d.out_of_scope_fact_ids));

  d = await pickDraftAngle(sb, WS, scoped, answers({ problem: 1, evidence: 1, why: 'x', same_argument: [] },
    [[1, '  EVERY MATCH, LIVE!  ']]));
  ok('case, spacing and punctuation are not the test', d.out_of_scope_fact_ids.join() === 'f-ruled-out', JSON.stringify(d));

  d = await pickDraftAngle(sb, WS, scoped, answers({ problem: 1, evidence: 1, why: 'x', same_argument: [] }, [[1, 'e']]));
  ok('a single letter is not a quote', d.out_of_scope_fact_ids.length === 0, JSON.stringify(d.out_of_scope_fact_ids));

  d = await pickDraftAngle(sb, WS, scoped, answers({ problem: 1, evidence: 1, why: 'x', same_argument: [] }, [[1, '']]));
  ok('and neither is nothing at all', d.out_of_scope_fact_ids.length === 0, JSON.stringify(d.out_of_scope_fact_ids));

  d = await pickDraftAngle(sb, WS, scoped, async (_text, job) => JSON.stringify(job === 'scope'
    ? { out_of_scope_facts: [1] }
    : { problem: 1, evidence: 1, why: 'x', same_argument: [] }));
  ok('a bare number, the old answer shape, rules nothing out on its own',
    d.reason === 'picked' && d.out_of_scope_fact_ids.length === 0, JSON.stringify(d));

  let scopeAsk = '';
  await pickDraftAngle(sb, WS, scoped, async (text, job) => {
    if (job === 'scope') scopeAsk = text;
    return JSON.stringify(job === 'scope' ? { out_of_scope_facts: [] } : { problem: 1, evidence: 1, why: '', same_argument: [] });
  });
  ok('the fact text the quote is checked against is the text it was shown',
    scopeAsk.includes('rights_deal: signed the tournament rights, every match live'), scopeAsk.slice(0, 300));

  console.log('\nA sorting call that fails must not stop the draft:');
  d = await pickDraftAngle(sb, WS, scoped, async (_text, job) => {
    if (job === 'scope') throw new Error('down');
    return JSON.stringify({ problem: 1, evidence: 2, why: 'the catalogue', same_argument: [] });
  });
  ok('the pick still runs, over every fact', d.reason === 'picked', JSON.stringify(d));
  ok('and nothing is reported as ruled out', d.out_of_scope_fact_ids.length === 0, JSON.stringify(d));

  d = await pickDraftAngle(sb, WS, scoped, async (_text, job) => (job === 'scope'
    ? 'not json'
    : JSON.stringify({ problem: 1, evidence: 1, why: '', same_argument: [] })));
  ok('an unreadable sort is the same as no flags', d.reason === 'picked' && d.out_of_scope_fact_ids.length === 0, JSON.stringify(d));

  console.log('\nEach call is told only what its own job needs:');
  let scopeSeen = '';
  pickSeen = '';
  await pickDraftAngle(sb, WS, scoped, async (text, job) => {
    if (job === 'scope') scopeSeen = text; else pickSeen = text;
    return JSON.stringify(job === 'scope'
      ? { out_of_scope_facts: [] }
      : { problem: 1, evidence: 1, why: '', same_argument: [] });
  });
  ok('the conditions reach the sorting call verbatim', scopeSeen.includes(scoped.out_of_scope[0]!), scopeSeen.slice(0, 300));
  ok('and its facts are numbered too, since it answers with numbers', /^1\. rights_deal/m.test(scopeSeen), scopeSeen.slice(0, 300));
  ok('the sorting call is not shown the menu of problems', /PROBLEMS THE SELLER SOLVES/.test(scopeSeen) === false, scopeSeen.slice(0, 400));
  ok('the pick is not shown the conditions at all', pickSeen.includes(scoped.out_of_scope[0]!) === false, pickSeen.slice(0, 300));

  const jobs: string[] = [];
  await pickDraftAngle(sb, WS, base, async (_text, job) => {
    jobs.push(job ?? '?');
    return JSON.stringify({ problem: 1, evidence: 1, why: '', same_argument: [] });
  });
  ok('a workspace with no conditions configured pays for one call, not two', jobs.join() === 'pick', jobs.join());

  console.log('\nThe facts have to be numbered, or a citation cannot refer to one:');
  let seen = '';
  await pickDraftAngle(sb, WS, base, async (text) => { seen = text; return JSON.stringify({ problem: 1, evidence: 1, why: '', same_argument: [] }); });
  ok('facts are numbered in the prompt', /^1\. business_model/m.test(seen), seen.slice(0, 200));
  ok('and the answer is asked for the number', /"evidence"/.test(seen) === false, 'the shape belongs in the system prompt, not the facts');

  // A written-down argument states a condition, and the condition is checked in
  // code rather than trusted to the prompt. This is the gate that stops the
  // measured failure: on Sudden, 90 accounts had the trigger and 27 had the
  // condition, so without it 63 messages assert something about a company that
  // nobody established — confidently, specifically, and to someone who knows
  // their own business better than we do.
  console.log('\nAn argument does not run until its condition is shown to hold:');
  const argued = {
    ...base,
    arguments: [{
      id: 'catalogue_lift',
      when: 'a new season lands',
      only_if: 'they run a catalogue with real depth',
      so: 'catch-up traffic grows on old titles',
      ask: 'put the catalogue on us, leave the premiere alone',
    }],
  };
  const argAnswer = (o: Record<string, unknown>) => answers(o);

  let a = await pickDraftAngle(sb, WS, argued, argAnswer({ argument: 1, trigger_evidence: 2, precondition_evidence: 1, why: 'launch + catalogue', same_argument: [1] }));
  ok('both facts present, the argument runs', a.reason === 'picked' && a.choice?.argument?.id === 'catalogue_lift', JSON.stringify(a));
  ok('and the message argues the SO, not a pain point', a.choice?.problem === 'catch-up traffic grows on old titles', JSON.stringify(a.choice));
  ok('the whole argument reaches the caller, so the ask survives', a.choice?.argument?.ask?.includes('leave the premiere alone') === true, JSON.stringify(a.choice));

  a = await pickDraftAngle(sb, WS, argued, argAnswer({ argument: 1, trigger_evidence: 2, precondition_evidence: 0, why: 'no catalogue evidence', same_argument: [] }));
  ok('trigger fired but condition unproven: NO message', a.choice === null && a.reason === 'precondition_unmet', JSON.stringify(a));

  a = await pickDraftAngle(sb, WS, argued, argAnswer({ argument: 1, trigger_evidence: 2, precondition_evidence: 99, why: 'made it up', same_argument: [] }));
  ok('a condition fact out of range is not a condition', a.choice === null && a.reason === 'precondition_unmet', JSON.stringify(a));

  a = await pickDraftAngle(sb, WS, argued, argAnswer({ argument: 1, precondition_evidence: 1, why: 'no trigger', same_argument: [] }));
  ok('no trigger fact is still no angle', a.choice === null && a.reason === 'no_evidence', JSON.stringify(a));

  a = await pickDraftAngle(sb, WS, argued, argAnswer({ argument: 0, trigger_evidence: 0, precondition_evidence: 0, why: 'nothing fits', same_argument: [] }));
  ok('no argument fits is a clean no', a.choice === null && a.reason === 'no_problem_fits', JSON.stringify(a));

  // An argument with nothing to check must not be blocked by the check.
  const noCondition = { ...base, arguments: [{ id: 'a1', when: 'they launch', so: 'cost grows', ask: 'try us' }] };
  a = await pickDraftAngle(sb, WS, noCondition, argAnswer({ argument: 1, trigger_evidence: 1, precondition_evidence: 0, why: 'nothing to check', same_argument: [] }));
  ok('an argument stating no condition runs on the trigger alone', a.reason === 'picked', JSON.stringify(a));

  // One argument IS a choice — "does this fire here" is the question — where one
  // pain point never was. Getting this wrong would silently switch the whole
  // mechanism off for any workspace that wrote down a single argument.
  const oneArg = { ...base, pain_points: ['only one'], arguments: [{ id: 'a1', when: 'they launch', so: 'cost grows', ask: 'try us' }] };
  a = await pickDraftAngle(sb, WS, oneArg, argAnswer({ argument: 1, trigger_evidence: 1, precondition_evidence: 0, why: 'fires', same_argument: [] }));
  ok('a single argument is enough to run the picker', a.reason === 'picked', JSON.stringify(a));

  // And the old path is untouched for every workspace that has none.
  const noArgs = await pickDraftAngle(sb, WS, base, answer({ problem: 1, evidence: 1, why: 'unchanged', same_argument: [] }));
  ok('a workspace with no arguments behaves exactly as before',
    noArgs.reason === 'picked' && noArgs.choice?.problem === base.pain_points[0] && noArgs.choice?.argument === undefined, JSON.stringify(noArgs));

  let argSeen = '';
  await pickDraftAngle(sb, WS, argued, async (text: string, job?: 'scope' | 'pick') => {
    if (job !== 'scope') argSeen = text;
    return JSON.stringify({ argument: 1, trigger_evidence: 2, precondition_evidence: 1, why: 'x', same_argument: [] });
  });
  ok('the condition is put in front of the model, not just checked after',
    /ONLY IF they run a catalogue with real depth/.test(argSeen), argSeen.slice(0, 300));
  ok('the pain-point menu is replaced, not appended',
    !/PROBLEMS THE SELLER SOLVES/.test(argSeen), argSeen.slice(0, 300));

  console.log(fail === 0 ? '\nOK: pick-angle assertions passed\n' : `\nFAILED: ${fail} assertion(s)\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
