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
  // The mode section these used to guard is gone. STEP 1 no longer teaches the
  // model to tell a published date from a recorded one, to test whether a theme
  // converges, or to judge when an event is too old, because it no longer picks
  // the anchor: the anchor arrives dated, inside the window and already checked.
  // What has to survive on every channel is that the model uses the one it was
  // given rather than shopping for a better fact.
  ['the anchor is given, not chosen', 'THE EVENT IS ALREADY CHOSEN'],
  ['and it must not be swapped', 'Do not quietly open on something else'],
  ['other facts are context, never the opening', 'Never as the opening.'],
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

console.log('\nSTEP 9 checks the anchor was used, and no longer asks about modes:');
for (const { name, opts } of CHANNELS) {
  const prompt = buildDrafterDecision(opts);
  ok(`${name} — checklist asks whether the anchor was used`,
    prompt.includes('Does the message open on the anchor you were given'));
  // The mode test contradicting itself across STEP 1 and STEP 9 was a real bug
  // once. It cannot come back by accident, but a half-finished revert would
  // leave one of the two behind, and that reads as the model's fault.
  ok(`${name} — no leftover mode vocabulary`,
    !prompt.includes('MODE A') && !prompt.includes('MODE B') && !prompt.includes('theme-led'));
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

// The same failure as the nine steps in the header, one feature later: the
// argument a workspace writes down rendered on the templated LinkedIn DM and
// nowhere else. Email is the DEFAULT channel and the only one the setup wizard
// produces, so every workspace it created stored an argument that never reached
// a message. Asserted per channel, with strings that appear nowhere in the
// prompt's own boilerplate, so a block that renders its heading and drops the
// content still fails.
console.log('\nThe argument reaches every channel, and replaces the menu when it is there:');
const ARG = {
  id: 'assert_arg',
  when: 'THEIR_TRIGGER_HAPPENED',
  only_if: 'THEIR_CONDITION_HOLDS',
  so: 'THEIR_COST_LANDS',
  ask: 'CHANGE_THIS_ONE_THING',
};
for (const { name, opts } of CHANNELS) {
  const withArg = buildDrafterDecision({
    ...opts,
    pain_points: ['A DIFFERENT PROBLEM ENTIRELY'],
    angle: { problem: ARG.so, argument: ARG },
  });
  ok(`${name} — states what it costs them`, withArg.includes('THEIR_COST_LANDS'));
  ok(`${name} — states what to ask for`, withArg.includes('CHANGE_THIS_ONE_THING'));
  ok(`${name} — states the event it is built on`, withArg.includes('THEIR_TRIGGER_HAPPENED'));
  // The menu is what the model reaches for when the argument is missing, and
  // reaching for it is how an unverified claim got into 3 drafts on 2026-08-22.
  // With an argument matched it must not be on the page at all.
  ok(`${name} — the problem menu is gone`, !withArg.includes('A DIFFERENT PROBLEM ENTIRELY'));
}
// And without one, nothing changes for a workspace that has written no arguments.
for (const { name, opts } of CHANNELS) {
  const noArg = buildDrafterDecision({ ...opts, pain_points: ['A DIFFERENT PROBLEM ENTIRELY'] });
  ok(`${name} — the menu still renders with no argument configured`, noArg.includes('A DIFFERENT PROBLEM ENTIRELY'));
}

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
