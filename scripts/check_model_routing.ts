/**
 * Assertions for which model runs which behavior.
 *
 * The bug this exists to prevent shipped and ran for months. `default_chat_model`
 * reads like it names the model that answers you in chat, and it did, but the
 * resolver also applied it to every other call that came through
 * chatCompleteForWorkspace. The guard meant to stop that asked whether the caller
 * had picked its own model, written as `model === args.model`, and `model` had
 * been assigned from `args.model` two lines above — so it was true on every call
 * that was not the drafter. Setting one field to try Claude in chat silently
 * moved the enricher, the scorer, the angle picker, the role classifier, the
 * source curator, the CSV mapping helper and the qualification agent with it. The
 * enricher alone is around two thirds of the model bill.
 *
 * Nothing in any log would have shown it. The run marker records the model that
 * was used, which would have read "claude" and looked deliberate.
 *
 * So the property to hold is narrow and blunt: a field that names one behavior
 * moves one behavior. Moving everything is possible, but only by typing
 * `models.default`, which nobody does by accident.
 *
 * Also pinned here: every behavior in MODEL_BEHAVIORS is reachable from config
 * and shows up in the settings list. A behavior that exists in code but not in
 * that list is one a customer cannot choose a model for, which is the failure
 * the three research entries were added to fix.
 */
import { execSync } from 'node:child_process';
import {
  resolveBehaviorModel,
  MODEL_BEHAVIORS,
  type ModelBehavior,
  type WorkspacePolicy,
} from '../packages/tools/src/policy.ts';

let fail = 0;
function ok(name: string, cond: boolean, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `\n        ${detail}`}`);
  if (!cond) fail++;
}

const CODE_DEFAULT = 'deepseek-v4-flash';
const ALL = MODEL_BEHAVIORS.map((b) => b.key);

console.log('\nUnset config leaves every behavior on the model its caller chose:');
for (const b of ALL) {
  ok(`${b}`, resolveBehaviorModel({}, b, CODE_DEFAULT) === CODE_DEFAULT,
    `got ${resolveBehaviorModel({}, b, CODE_DEFAULT)}`);
}

console.log('\nTHE REGRESSION: a field naming one behavior moves ONLY that behavior.');
const chatOnly: WorkspacePolicy = { llm: { default_chat_model: 'anthropic/claude-opus-4-7' } };
ok('default_chat_model moves chat', resolveBehaviorModel(chatOnly, 'intake', CODE_DEFAULT) === 'anthropic/claude-opus-4-7');
for (const b of ALL.filter((x) => x !== 'intake')) {
  ok(`default_chat_model does NOT move ${b}`,
    resolveBehaviorModel(chatOnly, b, CODE_DEFAULT) === CODE_DEFAULT,
    `got ${resolveBehaviorModel(chatOnly, b, CODE_DEFAULT)} — this is the bug that shipped`);
}

const drafterOnly: WorkspacePolicy = { llm: { drafter_model: 'anthropic/claude-opus-4-7' } };
ok('drafter_model moves the drafter', resolveBehaviorModel(drafterOnly, 'drafter', CODE_DEFAULT) === 'anthropic/claude-opus-4-7');
for (const b of ALL.filter((x) => x !== 'drafter')) {
  ok(`drafter_model does NOT move ${b}`,
    resolveBehaviorModel(drafterOnly, b, CODE_DEFAULT) === CODE_DEFAULT,
    `got ${resolveBehaviorModel(drafterOnly, b, CODE_DEFAULT)}`);
}

console.log('\nThe per-behavior map names one behavior at a time:');
const perBehavior: WorkspacePolicy = { llm: { models: { enricher: 'openai/gpt-5', research_relevance: 'deepseek/deepseek-v4-flash' } } };
ok('enricher takes its own entry', resolveBehaviorModel(perBehavior, 'enricher', CODE_DEFAULT) === 'openai/gpt-5');
ok('research_relevance takes its own entry', resolveBehaviorModel(perBehavior, 'research_relevance', CODE_DEFAULT) === 'deepseek/deepseek-v4-flash');
ok('the drafter is untouched by either', resolveBehaviorModel(perBehavior, 'drafter', CODE_DEFAULT) === CODE_DEFAULT);

console.log('\n`default` is the one way to move everything, and you have to type it:');
const globalDefault: WorkspacePolicy = { llm: { models: { default: 'openai/gpt-5' } } };
for (const b of ALL) {
  ok(`${b} follows models.default`, resolveBehaviorModel(globalDefault, b, CODE_DEFAULT) === 'openai/gpt-5');
}

console.log('\nMore specific wins over less specific:');
const layered: WorkspacePolicy = {
  llm: {
    models: { default: 'openai/gpt-5', scoring: 'deepseek/deepseek-v4-flash' },
    drafter_model: 'anthropic/claude-opus-4-7',
    default_chat_model: 'google/gemini-3-pro',
  },
};
ok('a named entry beats models.default', resolveBehaviorModel(layered, 'scoring', CODE_DEFAULT) === 'deepseek/deepseek-v4-flash');
ok('the legacy drafter field beats models.default', resolveBehaviorModel(layered, 'drafter', CODE_DEFAULT) === 'anthropic/claude-opus-4-7');
ok('the legacy chat field beats models.default', resolveBehaviorModel(layered, 'intake', CODE_DEFAULT) === 'google/gemini-3-pro');
ok('everything else still follows models.default', resolveBehaviorModel(layered, 'enricher', CODE_DEFAULT) === 'openai/gpt-5');

const mapWins: WorkspacePolicy = { llm: { models: { drafter: 'openai/gpt-5' }, drafter_model: 'anthropic/claude-opus-4-7' } };
ok('the map beats the legacy field for the same behavior', resolveBehaviorModel(mapWins, 'drafter', CODE_DEFAULT) === 'openai/gpt-5');

console.log('\npolicy.env keeps its priority over the matching llm.* field:');
const envOverride: WorkspacePolicy = {
  env: { DRAFTER_MODEL: 'openai/gpt-5', DEFAULT_CHAT_MODEL: 'openai/gpt-5-mini' },
  llm: { drafter_model: 'anthropic/claude-opus-4-7', default_chat_model: 'anthropic/claude-opus-4-7' },
};
ok('env.DRAFTER_MODEL wins', resolveBehaviorModel(envOverride, 'drafter', CODE_DEFAULT) === 'openai/gpt-5');
ok('env.DEFAULT_CHAT_MODEL wins', resolveBehaviorModel(envOverride, 'intake', CODE_DEFAULT) === 'openai/gpt-5-mini');
ok('env.DRAFTER_MODEL still does not leak to the enricher',
  resolveBehaviorModel(envOverride, 'enricher', CODE_DEFAULT) === CODE_DEFAULT);

console.log('\nJunk falls through to the next rung instead of sending an empty model id:');
for (const [label, bad] of [
  ['empty string', ''], ['whitespace', '   '], ['null', null], ['a number', 4000], ['an object', {}], ['an array', []],
] as Array<[string, unknown]>) {
  const p = { llm: { models: { enricher: bad as string } } } as WorkspacePolicy;
  ok(`enricher set to ${label} falls back`, resolveBehaviorModel(p, 'enricher', CODE_DEFAULT) === CODE_DEFAULT,
    `got ${JSON.stringify(resolveBehaviorModel(p, 'enricher', CODE_DEFAULT))}`);
}
ok('a padded id is trimmed rather than rejected',
  resolveBehaviorModel({ llm: { models: { enricher: '  openai/gpt-5  ' } } }, 'enricher', CODE_DEFAULT) === 'openai/gpt-5');

console.log('\nEvery behavior a customer can be billed for is listed in settings:');
// The list is what the settings page renders. A behavior missing from it is one
// nobody can point at a different model, which is the whole reason the three
// research entries exist — those calls used to bypass workspace policy entirely.
const listed = new Set<ModelBehavior>(ALL);
for (const required of ['drafter', 'enricher', 'scoring', 'intake', 'research_planner', 'research_brief', 'research_relevance'] as ModelBehavior[]) {
  ok(`${required} is settable`, listed.has(required));
}
ok('no duplicate keys in the settings list', listed.size === ALL.length, `${ALL.length} entries, ${listed.size} unique`);
ok('every entry has a label and a plain-English hint',
  MODEL_BEHAVIORS.every((b) => b.label.trim().length > 0 && b.hint.trim().length > 10));

/**
 * Setting a model per behavior only works if the call READS the setting. The
 * research planner, the brief writer and the page filter each called
 * chatComplete directly, so for months they ignored workspace config entirely —
 * the model was fixed in code and the deployment's DeepSeek key paid for every
 * customer's research. Nothing surfaced it, because a call with the right model
 * hardcoded looks identical in every log to one that resolved it.
 *
 * So the call sites are pinned, not just the resolver. Anything reaching
 * chatComplete without going through chatCompleteForWorkspace has to be on this
 * list with a reason.
 */
const DIRECT_CALL_EXEMPT: Array<{ file: string; why: string }> = [
  // These four run during setup, before there is a workspace row to read a
  // policy from. deriveDefaults and deriveArguments are called by
  // /api/workspaces/create with nothing saved yet; generate-spec and
  // sources/parse take no workspace_id at all. They are one call each per
  // workspace, on the cheap model, so the bill is not the issue — the
  // constraint is that the config genuinely does not exist yet.
  { file: 'apps/web/app/api/workspaces/_derive_defaults.ts', why: 'runs before the workspace exists' },
  { file: 'apps/web/app/api/workspaces/_derive_arguments.ts', why: 'runs before the workspace exists' },
  { file: 'apps/web/app/api/connectors/generate-spec/route.ts', why: 'setup helper, takes no workspace_id' },
  { file: 'apps/web/app/api/sources/parse/route.ts', why: 'setup helper, workspace_id is optional' },
];

console.log('\nEvery LLM call reads workspace config, or is a listed exception:');
const grep = 'grep -rn "chatComplete(\\|chatCompleteStream(" --include="*.ts" packages/tools packages/agents inngest apps/web/app --exclude-dir=node_modules';
let found: string[] = [];
try {
  found = execSync(grep, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split(':')[0] ?? '')
    // chat_workspace.ts IS the wrapper, so it is the one file that must call
    // through. .next is build output, not source.
    .filter((f) => !f.includes('chat_workspace.ts') && !f.includes('/.next/'));
} catch {
  // grep exits 1 when nothing matches, which is the healthy case.
}
const exempt = new Set(DIRECT_CALL_EXEMPT.map((e) => e.file));
const unexpected = [...new Set(found)].filter((f) => !exempt.has(f));
ok('no unlisted file calls the model directly', unexpected.length === 0,
  `these bypass workspace config (model AND api key) — route them through chatCompleteForWorkspace or add them to DIRECT_CALL_EXEMPT with a reason:\n        ${unexpected.join('\n        ')}`);
for (const e of DIRECT_CALL_EXEMPT) {
  ok(`exemption still applies: ${e.file.split('/').pop()} (${e.why})`, found.includes(e.file),
    'this file no longer calls the model directly — drop it from DIRECT_CALL_EXEMPT');
}

console.log(fail ? `\n${fail} FAILED\n` : '\nAll model-routing assertions pass.\n');
process.exit(fail ? 1 : 0);
