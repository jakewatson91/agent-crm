/**
 * Assertions for the per-behavior output-token ceiling.
 *
 * The thing worth pinning is not the numbers, which are fitted to measurement
 * and will move again. It is that a ceiling can only ever be raised by config
 * and never silently lowered to junk, and that every behavior the agent path
 * can run has one.
 *
 * Why it matters: the model is never told the ceiling, so setting it too low
 * does not make a call cheaper. It cuts the JSON off mid-object, chatComplete
 * sees unparseable JSON and re-sends the entire prompt at 3x the budget, and
 * the run bills twice. Measured over 30 days before this landed, that was
 * 2286 of 2295 scoring runs, 1168 of 1674 enricher runs, and 18 of 103
 * drafter runs. A wrong value here is invisible in every log except the token
 * bill, which is exactly the kind of thing an assertion should hold.
 */
import { resolveMaxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, type WorkspacePolicy } from '../packages/tools/src/policy.ts';

let fail = 0;
function ok(name: string, cond: boolean, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `\n        ${detail}`}`);
  if (!cond) fail++;
}

const BEHAVIORS = ['enricher', 'drafter', 'scoring', 'claim_poster'] as const;

console.log('\nEvery behavior the agent path runs has a ceiling, and none is tight:');
for (const b of BEHAVIORS) {
  const v = resolveMaxOutputTokens({}, b);
  ok(`${b} — unset falls back to the code default`, v === DEFAULT_MAX_OUTPUT_TOKENS[b], `got ${v}`);
  // The old ceilings were scoring 350, enricher/claim_poster 1200, drafter 3000,
  // and all three measured behaviors overran theirs. Nothing should land back there.
  ok(`${b} — clears the measured p90 of the call it budgets`, v >= 2000, `got ${v}`);
}

console.log('\nA workspace can raise or lower its own ceiling:');
const raised: WorkspacePolicy = { llm: { max_output_tokens: { scoring: 12000 } } };
ok('a set value wins over the default', resolveMaxOutputTokens(raised, 'scoring') === 12000);
ok('a sibling behavior still gets its default',
  resolveMaxOutputTokens(raised, 'enricher') === DEFAULT_MAX_OUTPUT_TOKENS.enricher);

console.log('\nJunk in policy falls back rather than sending max_tokens the provider will reject:');
for (const [label, bad] of [
  ['zero', 0], ['negative', -1], ['NaN', Number.NaN], ['Infinity', Number.POSITIVE_INFINITY],
  ['a string', '4000'], ['null', null], ['an object', {}],
] as const) {
  const p = { llm: { max_output_tokens: { enricher: bad } } } as unknown as WorkspacePolicy;
  ok(`${label} falls back to the default`,
    resolveMaxOutputTokens(p, 'enricher') === DEFAULT_MAX_OUTPUT_TOKENS.enricher,
    `got ${resolveMaxOutputTokens(p, 'enricher')}`);
}

console.log('\nAn empty or absent llm block is not an error:');
ok('no llm block', resolveMaxOutputTokens({}, 'drafter') === DEFAULT_MAX_OUTPUT_TOKENS.drafter);
ok('empty llm block', resolveMaxOutputTokens({ llm: {} }, 'drafter') === DEFAULT_MAX_OUTPUT_TOKENS.drafter);
ok('empty max_output_tokens block',
  resolveMaxOutputTokens({ llm: { max_output_tokens: {} } }, 'drafter') === DEFAULT_MAX_OUTPUT_TOKENS.drafter);

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
