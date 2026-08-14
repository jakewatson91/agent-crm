/**
 * Assertions for what happens when the relevance gate cannot read a batch.
 *
 * Two bugs, one root. On 2026-08-13 DeepSeek ran out of credit at 8pm. The gate
 * caught the error, threw the message away, and recorded "relevance gate
 * unreadable on 4 batch(es)". Research then kept running hourly until midnight,
 * buying Exa pages it dropped unjudged, because nothing in the research loop
 * latches a pause on a model wall — only the advance pass does, and that was
 * not due to run until morning.
 *
 * So: the reason has to survive the catch, and a reason that says "out of
 * credit" has to stop the loop. A rate limit must NOT, for the reason spelled
 * out on isPersistentWall — latching on a 429 once left a healthy workspace
 * dark for three days.
 */
import { gateFailureReason } from '../packages/tools/src/research_strategy.ts';
import { isPersistentWall } from '../inngest/functions/advance_accounts.ts';

let fail = 0;
function ok(name: string, cond: boolean, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `\n        ${detail}`}`);
  if (!cond) fail++;
}

console.log('\nThe three ways a batch dies are told apart:');

const refused = gateFailureReason({
  answered: false, text: '', finish: '',
  error: new Error('Insufficient Balance'),
});
ok('the provider refused: its own words, passed through for the operator',
  refused === 'Insufficient Balance', refused);

const empty = gateFailureReason({
  answered: true, text: '', finish: 'length',
  error: new SyntaxError('Unexpected end of JSON input'),
});
ok('the answer came back empty: says so, and says the model ran out of room',
  empty.includes('no content') && empty.includes('length'), empty);

const garbled = gateFailureReason({
  answered: true, text: '{"keep":[{"i":0', finish: 'stop',
  error: new SyntaxError('Unexpected end of JSON input'),
});
ok('the answer came back malformed: named as a parse problem, not an outage',
  garbled.startsWith('model returned unparseable JSON'), garbled);

ok('an empty answer is never mistaken for a refusal', empty !== refused);
ok('the reason is bounded, so a stack trace cannot bloat the event payload',
  gateFailureReason({ answered: false, text: '', finish: '', error: new Error('x'.repeat(5000)) }).length === 200);

console.log('\nWhich reasons stop the research loop:');
for (const wall of [
  'Insufficient Balance',
  'model returned no content (finish_reason=length)|402 payment required',
  'Unauthorized',
  'invalid api key',
]) {
  ok(`"${wall.slice(0, 40)}" latches a pause`, isPersistentWall(wall));
}
for (const transient of [
  'model returned no content (finish_reason=length)',
  'model returned unparseable JSON: Unexpected end of JSON input',
  'Too Many Requests',
  '429 rate limit exceeded',
]) {
  ok(`"${transient.slice(0, 46)}" does NOT`, !isPersistentWall(transient));
}

console.log(fail === 0 ? '\nOK: gate failure assertions passed\n' : `\nFAILED: ${fail} assertion(s)\n`);
process.exit(fail === 0 ? 0 : 1);
