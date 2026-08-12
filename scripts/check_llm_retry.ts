/**
 * Assertions for the provider-blip retry in chatComplete.
 *
 * The bug this pins: the AI SDK reports "provider answered 200, body would not
 * parse" as APICallError with statusCode 200, and its own retry skips it
 * because isRetryable is only true for 408/409/429/5xx. chatComplete had no
 * try/catch, so that throw ended the run — agentRun wrote agent_llm_failed and
 * skipped, no second try and no fallback model. Over the 24h to 2026-08-12 it
 * cost 12 of 69 enricher runs and 3 of 52 scoring runs, and not one of them
 * completed on a later pass.
 *
 * Equally important is the other direction: an out-of-credit or bad-key error
 * must NOT be retried. Those need an operator, and repeating them three times
 * only delays the alert while burning the retry budget.
 */
import { APICallError } from 'ai';
import { isWorthRetrying, callWithRetry, type ChatCompleteArgs, type ChatCompleteResult } from '../packages/primitives/src/llm.ts';

let fail = 0;
function ok(name: string, cond: boolean, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `\n        ${detail}`}`);
  if (!cond) fail++;
}

const apiError = (statusCode: number | undefined, message: string) => new APICallError({
  message, url: 'https://api.example/v1/chat/completions', requestBodyValues: {}, statusCode,
});

/** The exact error DeepSeek produced 44 times in the 7 days to 2026-08-12. */
const parseFailure = () => apiError(200, 'Failed to process successful response');

console.log('\nA provider blip is worth another attempt:');
ok('200 with a body the SDK could not parse', isWorthRetrying(parseFailure()));
ok('429 rate limit', isWorthRetrying(apiError(429, 'Too Many Requests')));
ok('500 provider error', isWorthRetrying(apiError(500, 'Internal Server Error')));
ok('a failure with no status at all', isWorthRetrying(apiError(undefined, 'socket hang up')));

console.log('\nAnything a person has to fix is thrown straight through:');
for (const [status, label] of [
  [400, 'malformed request'], [401, 'bad key'], [402, 'out of credit'],
  [403, 'not allowed'], [404, 'unknown model id'],
] as const) {
  ok(`${status} ${label}`, !isWorthRetrying(apiError(status, label)));
}
ok('DeepSeek "Insufficient Balance" (402), seen 20x in 7d', !isWorthRetrying(apiError(402, 'Insufficient Balance')));
ok('a plain Error from our own code', !isWorthRetrying(new Error('boom')));
ok('a missing API key', !isWorthRetrying(new Error('Missing DEEPSEEK_API_KEY for deepseek-direct model x')));

// ---- attempt counting, no network ----
const ARGS: ChatCompleteArgs = { model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] };
const result = (text: string): ChatCompleteResult => ({
  text, input_tokens: 1, output_tokens: 1, cached_input_tokens: 0, provider: 'deepseek', model: ARGS.model,
});

async function main() {
  console.log('\nHow many times the same request actually goes out:');

  let calls = 0;
  const recovers = await callWithRetry(ARGS, async () => {
    calls++;
    if (calls === 1) throw parseFailure();
    return result('{"ok":true}');
  });
  ok('a blip on the first attempt still returns an answer', recovers.text === '{"ok":true}', `got ${recovers.text}`);
  ok('and it took exactly 2 attempts', calls === 2, `took ${calls}`);

  calls = 0;
  let threw: unknown;
  try {
    await callWithRetry(ARGS, async () => { calls++; throw parseFailure(); });
  } catch (e) { threw = e; }
  ok('a provider that stays broken gives up after 3 attempts', calls === 3, `took ${calls}`);
  ok('and the original error reaches the caller, so agent_llm_failed still records it',
    APICallError.isInstance(threw) && threw.message === 'Failed to process successful response');

  calls = 0;
  try {
    await callWithRetry(ARGS, async () => { calls++; throw apiError(402, 'Insufficient Balance'); });
  } catch { /* expected */ }
  ok('an out-of-credit error is not retried at all', calls === 1, `took ${calls}`);

  calls = 0;
  const clean = await callWithRetry(ARGS, async () => { calls++; return result('{"fine":1}'); });
  ok('a healthy call is one call, unchanged', calls === 1 && clean.text === '{"fine":1}', `took ${calls}`);

  console.log(fail === 0 ? '\nOK: llm retry assertions passed\n' : `\nFAILED: ${fail} assertion(s)\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
