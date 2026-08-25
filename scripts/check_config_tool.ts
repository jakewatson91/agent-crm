/**
 * Assertions for the config an agent may change.
 *
 * This tool exists because the most consequential sentences in the system were
 * reachable by nobody. The research questions have no screen anywhere in the
 * app, so the question about what an executive had said regarding delivery costs
 * sat too narrow for months with no search behind it, and the only way to widen
 * it was a script written by hand.
 *
 * Giving an agent the ability to edit config is the fix and also the risk, so
 * the two properties worth holding are narrow: it can only reach the things that
 * are a customer decision, and it cannot reach a secret. `policy` is one jsonb
 * blob that holds arguments and questions right next to API keys, embedding
 * caches, pipeline state and the planner's own bookkeeping. An allowlist is the
 * only thing between "widen that question" and "overwrite the DeepSeek key".
 */
import { CONFIG_SECTIONS, isConfigSection, stageConfigChange } from '../packages/tools/src/workspace_config.ts';
import type { WorkspacePolicy } from '../packages/tools/src/policy.ts';

let fail = 0;
function ok(name: string, cond: boolean, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `\n        ${detail}`}`);
  if (!cond) fail++;
}

const SECTIONS = Object.keys(CONFIG_SECTIONS);

async function main() {
console.log('\nNothing on the allowlist is a secret or machine bookkeeping:');
// Substring match on purpose: it should be impossible to add "llm.openai_api_key"
// without this failing, whatever it is called.
for (const banned of ['api_key', 'key', 'secret', 'token', 'embedding_cache', 'env', 'pipeline', '_generated_at', '_input_hash', '_last_error']) {
  const hit = SECTIONS.filter((s) => s.toLowerCase().includes(banned));
  ok(`no section contains "${banned}"`, hit.length === 0,
    `${hit.join(', ')} — an agent must not be able to write this`);
}

console.log('\nEvery section says what it decides, in words a customer would use:');
for (const [s, def] of Object.entries(CONFIG_SECTIONS)) {
  ok(`${s} is explained`, def.what.trim().length > 30,
    'the description is what the model reads to decide whether this is the right section');
}

console.log('\nA section off the allowlist is refused, before any read happens:');
for (const attempt of ['llm.deepseek_api_key', 'env', 'research.brief_input_hash', 'suppression_list', '__proto__']) {
  ok(`${attempt} is not editable`, !isConfigSection(attempt),
    'this reaches a secret, a cache, or the planner\'s own state');
}
{
  // The refusal has to come out of stageConfigChange itself, not from the caller
  // remembering to check first. Handing it a client that throws on any use
  // proves it rejects the section before it reads anything.
  const exploding = { from() { throw new Error('touched the database on a refusal'); } } as never;
  const r = await stageConfigChange(exploding, 'ws', 'llm.deepseek_api_key', 'sk-stolen');
  ok('and it refuses without reading the policy first', 'error' in r,
    'a refusal that happens after the read is a refusal the next caller can skip');
}

console.log('\nSection paths stay shallow enough for the write helper to be safe:');
ok('every allowlisted section is at most two levels deep',
  SECTIONS.every((s) => s.split('.').length <= 2),
  'deeper paths mean creating intermediate objects that nothing on this list validates');
void ({} as WorkspacePolicy);

console.log('\nThe sections a customer actually asked about are present:');
for (const required of ['drafter.arguments', 'research.brief', 'research.strategy', 'llm.models']) {
  ok(`${required} is editable`, isConfigSection(required),
    'this is one of the things that had no way to be reached at all');
}

console.log(fail ? `\n${fail} FAILED\n` : '\nAll config-tool assertions pass.\n');
process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
