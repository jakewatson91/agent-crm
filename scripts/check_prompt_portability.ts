/**
 * Assertions that the shared drafter prompt is workspace-neutral.
 *
 * The craft block in prompt_builders.ts is shared by every workspace, so an
 * example borrowed from whichever book we happen to be running leaks into every
 * customer's prompt. Three had got in before anyone noticed: a two-year-old case
 * study "naming a particular encoder", a "traffic number" beating a conference
 * appearance, and a think question aimed at "their peak". All three read fine to
 * someone who had spent months on a video-delivery book and are noise to a
 * workspace selling houses or staffing shifts.
 *
 * A hand-run grep does not catch the fourth one, so it is a build step. VERTICAL
 * is the blocklist; add to it when a new leak is found rather than widening it
 * speculatively — a term that also appears in a legitimately generic sentence
 * costs a false failure every run.
 *
 * The other half of the file pins the thing that made the leaks matter: the nine
 * steps used to render on ONE of three channels, so the default channel (email)
 * shipped with none of the age rules, no mode test and no think question. Each
 * channel is asserted separately because they are three different return paths.
 */
import { buildDrafterDecision, type DrafterDecisionOpts } from '../packages/tools/src/prompt_builders.ts';

let fail = 0;
function ok(name: string, pass: boolean, detail?: string) {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${pass || !detail ? '' : `\n        ${detail}`}`);
  if (!pass) fail++;
}

/** Terms that only mean something inside one customer's vertical. */
const VERTICAL = [
  'encoder', 'transcode', 'codec', 'bitrate', 'buffering',
  'CDN', 'egress', 'origin server',
  'viewer', 'concurrency', 'concurrent', 'streaming', 'playback',
  'SaaS', 'B2B', 'real estate', 'candidate pipeline',
];

/** The channels, each built with NO workspace config at all. */
const CHANNELS: Array<{ name: string; opts: DrafterDecisionOpts }> = [
  { name: 'email (default channel)', opts: {} },
  { name: 'linkedin, no templates', opts: { outreach_channel: 'linkedin' } },
  {
    name: 'linkedin, templated',
    opts: {
      outreach_channel: 'linkedin',
      templates: [{ id: 't1', label: 'Ops lead', audience: 'the person who owns the budget', body: 'exemplar body' }],
    },
  },
];

console.log('\nNo vertical term reaches a prompt built with empty config:');
for (const { name, opts } of CHANNELS) {
  const prompt = buildDrafterDecision(opts).toLowerCase();
  const hits = VERTICAL.filter((t) => prompt.includes(t.toLowerCase()));
  ok(`${name} — clean`, hits.length === 0, `leaked: ${hits.join(', ')}`);
}

console.log('\nThe craft reaches every channel, not just the templated DM:');
// STEP 0 is conditional on out_of_scope and checked separately below. The named
// rules are the ones a channel could plausibly lose without the step headings
// changing.
const REQUIRED: Array<[string, string]> = [
  ...['STEP 1', 'STEP 2', 'STEP 3', 'STEP 4', 'STEP 5', 'STEP 6', 'STEP 7', 'STEP 8', 'STEP 9']
    .map((s) => [s, s] as [string, string]),
  ['age rule', 'AGE KILLS EVENTS, NOT STATE'],
  ['undated fact cannot be a trigger', 'An undated fact can NEVER be the trigger'],
  ['a theme may be entirely undated', 'A THEME MAY REST ENTIRELY ON UNDATED FACTS'],
  ['think question', 'WRITE THE THINK QUESTION'],
  ['never ask for time', 'NEVER ASK FOR TIME'],
  ['no internal field names', 'NEVER NAME INTERNAL DATA OR FIELD NAMES'],
  ['identity is never a hook', 'Who they are is never a hook'],
];
for (const { name, opts } of CHANNELS) {
  const prompt = buildDrafterDecision(opts);
  const missing = REQUIRED.filter(([, needle]) => !prompt.includes(needle)).map(([label]) => label);
  ok(`${name}`, missing.length === 0, `missing: ${missing.join(', ')}`);
}

console.log('\nSTEP 9 does not contradict STEP 1 on whether a theme needs dated facts:');
for (const { name, opts } of CHANNELS) {
  const prompt = buildDrafterDecision(opts);
  ok(`${name} — checklist allows an undated theme`,
    prompt.includes('A trigger needs a date. A theme does not.') && !prompt.includes('two or more dated facts'));
}

console.log('\nThe out-of-scope refusal renders on every channel, and only when configured:');
for (const { name, opts } of CHANNELS) {
  ok(`${name} — absent with no conditions set`, !buildDrafterDecision(opts).includes('STEP 0'));
  const withScope = buildDrafterDecision({ ...opts, out_of_scope: ['They resell what we sell.'] });
  ok(`${name} — present with one condition set`,
    withScope.includes('STEP 0') && withScope.includes('They resell what we sell.'));
}

console.log('\nSTEP 5 bans a CTA the shared defaults must not hand back:');
// The default ask_examples used to include one of STEP 5's own banned phrases,
// so the prompt banned it in one paragraph and offered it in another. Each
// banned phrase may appear exactly once: inside the ban list itself.
const BANNED_CTA = ['Open to a quick chat?', 'Worth a quick call?', 'Do you have 15 minutes?', 'Can we sync?'];
for (const { name, opts } of CHANNELS) {
  const prompt = buildDrafterDecision(opts);
  const doubled = BANNED_CTA.filter((p) => prompt.split(p).length - 1 > 1);
  ok(`${name} — no banned CTA offered as an example`, doubled.length === 0, `offered as well as banned: ${doubled.join(', ')}`);
}

console.log('\nLanguage is config, not code:');
ok('defaults to English', buildDrafterDecision({}).includes('Write in English, always'));
ok('a workspace can set another language',
  buildDrafterDecision({ outreach_language: 'German' }).includes('Write in German, always'));
ok('blank falls back rather than emitting an empty rule',
  buildDrafterDecision({ outreach_language: '   ' }).includes('Write in English, always'));

console.log('\nWorkspace content appears only when the workspace supplies it:');
const empty = buildDrafterDecision({});
ok('no pain bullets with none configured', !empty.includes('   - '));
const configured = buildDrafterDecision({ pain_points: ['Their invoices go out late.'], value_props: ['Sends the invoice the day the job closes.'] });
ok('configured pains render', configured.includes('Their invoices go out late.'));
ok('configured value props render', configured.includes('Sends the invoice the day the job closes.'));

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
