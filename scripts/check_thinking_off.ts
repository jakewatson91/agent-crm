/**
 * Assertions for turning the model's thinking off on fixed-shape calls.
 *
 * The bug this pins: DeepSeek bills reasoning tokens as output AND counts them
 * against max_tokens. The relevance gate asked for 10 pages judged under a
 * 900-token ceiling; the model spent all 900 thinking, returned an empty
 * string, and the fail-closed handler dropped all 10 pages unjudged. The
 * 4000-token retry and the fallback model did the same thing. On 2026-08-14
 * that was 36% of research runs and 269 pages, every one of them already paid
 * for at Exa. With thinking off the same batch answers in ~150 tokens.
 *
 * Two things have to hold, and both fail silently if they break:
 *
 * 1. The wire shape. DeepSeek reads `thinking.type` from a `deepseek` block in
 *    providerOptions. A typo anywhere in that path is not an error — the option
 *    is simply ignored and the call goes back to thinking, at 30x the tokens.
 * 2. The setting survives chatComplete's retry ladder. The roomy retry and the
 *    fallback-model rung each rebuild the args; either one dropping `thinking`
 *    puts the expensive path back exactly where the first call escaped it.
 */
import { readFileSync } from 'node:fs';
import { providerOptionsFor, chatComplete, type ChatCompleteArgs, type ChatCompleteResult } from '../packages/primitives/src/llm.ts';

let fail = 0;
function ok(name: string, cond: boolean, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `\n        ${detail}`}`);
  if (!cond) fail++;
}

const base: ChatCompleteArgs = { model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] };

console.log('\nThe wire shape DeepSeek actually reads:');
const off = providerOptionsFor({ ...base, thinking: 'disabled' });
ok('thinking: disabled -> { deepseek: { thinking: { type: "disabled" } } }',
  JSON.stringify(off) === '{"deepseek":{"thinking":{"type":"disabled"}}}',
  `got ${JSON.stringify(off)}`);
ok('thinking: enabled -> the same path, type enabled',
  JSON.stringify(providerOptionsFor({ ...base, thinking: 'enabled' })) === '{"deepseek":{"thinking":{"type":"enabled"}}}');
ok('unset -> no providerOptions at all (writing/judging calls are untouched)',
  providerOptionsFor(base) === undefined);

// ---- the setting survives every rung of the ladder, no network ----
const seen: Array<{ max_tokens?: number; model: string; thinking?: string }> = [];
const badJson = (a: ChatCompleteArgs): Promise<ChatCompleteResult> => {
  seen.push({ max_tokens: a.max_tokens, model: a.model, thinking: a.thinking });
  // Exactly what the gate got back: content that will not parse, on every rung.
  return Promise.resolve({
    text: '', input_tokens: 0, output_tokens: 0, cached_input_tokens: 0,
    provider: 'deepseek', model: a.model,
  });
};

async function main() {
  console.log('\nEvery rung of the JSON-resilience ladder keeps it:');
  await chatComplete({ ...base, max_tokens: 900, thinking: 'disabled', response_format: { type: 'json_object' } }, badJson);
  ok('all three rungs ran (first, roomy retry, fallback model)', seen.length === 3, `ran ${seen.length}`);
  ok('first call keeps thinking off at the caller\'s ceiling',
    seen[0]?.thinking === 'disabled' && seen[0]?.max_tokens === 900, JSON.stringify(seen[0]));
  ok('roomy retry keeps thinking off', seen[1]?.thinking === 'disabled', JSON.stringify(seen[1]));
  ok('fallback model keeps thinking off', seen[2]?.thinking === 'disabled', JSON.stringify(seen[2]));
  ok('fallback rung is a different model', seen[2]?.model !== seen[0]?.model);

  seen.length = 0;
  await chatComplete({ ...base, max_tokens: 900, response_format: { type: 'json_object' } }, badJson);
  ok('a call that never asked stays unset on every rung',
    seen.every((s) => s.thinking === undefined), JSON.stringify(seen));

  // The drafter, pinned by reading the call site. It is the one behavior where
  // the setting was measured on the writing itself rather than on cost, and it
  // shares a call with the enricher and the scorer, so a careless edit there
  // silently puts every draft back on the reasoning path at 22x the tokens.
  console.log('\nThe drafter call site, which shares one call with three other behaviors:');
  const src = readFileSync(new URL('../inngest/functions/agent_logic.ts', import.meta.url), 'utf8');
  const call = src.slice(src.indexOf('llm = await chatCompleteForWorkspace'), src.indexOf('} catch (e) {'));
  ok('the drafter asks for thinking off', /behavior === 'drafter' \? \{ thinking: 'disabled'/.test(call), call.slice(0, 200));
  ok('and only the drafter, so the enricher and scorer are untouched',
    !/thinking: 'disabled' as const \}\s*:\s*\{ thinking/.test(call));

  console.log(fail === 0 ? '\nOK: thinking-off assertions passed\n' : `\nFAILED: ${fail} assertion(s)\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
