/**
 * Assertions for the three-message trial an unconfirmed argument runs.
 *
 * The rule: a new or rewritten argument writes three messages and stops until a
 * human says they made sense. It exists because the first argument this
 * workspace ever had ran 26 messages in a week arguing the opposite of what the
 * seller sells, and the only thing that caught it was a person reading the
 * output days later.
 *
 * Two ways that rule was broken, both silent, both fixed here.
 *
 * 1. The confirmation was cleared in the BROWSER. The settings page deleted
 *    proven_at when the wording changed and the server kept whatever it was
 *    sent. That was survivable while the settings page was the only editor. It
 *    stopped being survivable the moment config could be edited by an agent:
 *    a tool sending back the stored proven_at alongside new words would have
 *    put rewritten wording in front of every account with no samples and nobody
 *    reading them. A check that only runs in one client is not a limit.
 *
 * 2. The count was per ID, and the id survives a rewrite. So editing an
 *    argument cleared its confirmation, then found the three drafts its
 *    predecessor had written sitting under the same id, and refused to write
 *    anything. The edit produced nothing and the alert told the customer to go
 *    read three messages written under wording that no longer existed. The
 *    research angles hit this exact bug first and solved it with record_since;
 *    the fix was never generalised, so the next thing built with an id
 *    inherited it.
 */
import { stampArgumentChanges, type DrafterArgument } from '../packages/tools/src/policy.ts';

let fail = 0;
function ok(name: string, cond: boolean, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `\n        ${detail}`}`);
  if (!cond) fail++;
}

const NOW = '2026-08-25T12:00:00.000Z';
const base: DrafterArgument = {
  id: 'catalogue_lift',
  label: 'A new release lifts the back catalogue',
  when: 'a new season, film or series lands on their service',
  only_if: 'they run an on-demand catalogue with real depth',
  so: 'viewers go back through the earlier seasons',
  ask: 'put the older seasons on us, leaving the premiere alone',
  proven_at: '2026-08-01T00:00:00.000Z',
};

console.log('\nAn untouched argument keeps its confirmation:');
{
  const [out] = stampArgumentChanges([{ ...base }], [base], NOW);
  ok('proven_at survives', out!.proven_at === base.proven_at);
  ok('no stamp is invented for wording that never changed', out!.words_changed_at === undefined);
}

console.log('\nEditing any of the four lines that decide what a message argues drops it:');
for (const field of ['when', 'only_if', 'so', 'ask'] as const) {
  const edited = { ...base, [field]: 'something materially different' };
  const [out] = stampArgumentChanges([edited], [base], NOW);
  ok(`${field} changed -> unconfirmed`, out!.proven_at === undefined,
    'a rewritten argument would run on every account with no samples');
  ok(`${field} changed -> trial restarts from now`, out!.words_changed_at === NOW);
}

console.log('\nRenaming is not rewriting:');
{
  const [out] = stampArgumentChanges([{ ...base, label: 'Back catalogue' }], [base], NOW);
  ok('label alone keeps the confirmation', out!.proven_at === base.proven_at,
    'forcing three fresh samples for a typo fix teaches people not to tidy their settings');
}

console.log('\nA brand new argument arrives unconfirmed whatever it claims:');
{
  const sneaky: DrafterArgument = { ...base, id: 'brand_new', proven_at: '2020-01-01T00:00:00.000Z' };
  const [out] = stampArgumentChanges([sneaky], [], NOW);
  ok('proven_at supplied by the caller is discarded', out!.proven_at === undefined,
    'this is the exact payload an agent would send to skip the trial');
  ok('its trial starts now', out!.words_changed_at === NOW);
}

console.log('\nThe stamp is carried, not refreshed, when something else in policy is saved:');
{
  const stamped: DrafterArgument = { ...base, words_changed_at: '2026-08-10T00:00:00.000Z' };
  const [out] = stampArgumentChanges([{ ...stamped }], [stamped], NOW);
  ok('an unrelated save does not restart the trial', out!.words_changed_at === '2026-08-10T00:00:00.000Z',
    'every policy save would otherwise hand the argument a fresh three messages');
}

console.log('\nOne argument being edited leaves its siblings alone:');
{
  const other: DrafterArgument = { ...base, id: 'other', proven_at: '2026-07-01T00:00:00.000Z' };
  const out = stampArgumentChanges(
    [{ ...base, so: 'a different claim entirely' }, { ...other }],
    [base, other],
    NOW,
  );
  ok('the edited one is unconfirmed', out[0]!.proven_at === undefined);
  ok('the untouched one keeps its confirmation', out[1]!.proven_at === other.proven_at);
}

console.log('\nAn argument that has never been edited counts everything (old behaviour):');
{
  const [out] = stampArgumentChanges([{ ...base }], [base], NOW);
  ok('no stamp means no cutoff, so the count is unchanged for existing workspaces',
    out!.words_changed_at === undefined,
    'stamping an untouched argument would hand every live workspace three free messages');
}

// The counter in inngest/functions/agent_logic.ts is what consumes the stamp.
// Pinned by source because the query needs a database to run, and the thing
// worth holding is that it applies the cutoff and discounts rejections at all.
console.log('\nThe drafter actually uses the stamp, and does not count rejections:');
{
  const src = require('node:fs').readFileSync('inngest/functions/agent_logic.ts', 'utf8') as string;
  ok('the trial count is bounded by words_changed_at',
    src.includes("q.gte('created_at', angle.argument.words_changed_at)"),
    'without the cutoff, editing an argument writes nothing at all');
  ok('rejected messages are subtracted from the trial count',
    src.includes("d.decision === 'reject') rejected++") && src.includes('posts.length - rejected'),
    'rejecting all three otherwise leaves the argument stuck at three forever');
  // The confirmation itself. Approving the trial messages is the human looking,
  // and it happens in the queue on better evidence than the settings screen can
  // show. Before this, three approvals still left the argument blocked: measured
  // at 103 refusals across 28 accounts over seven days on the live workspace.
  ok('enough approvals confirm the argument on their own',
    src.includes('approved >= UNPROVEN_ARGUMENT_DRAFT_LIMIT'),
    'without it, approving every trial message still leaves the book blocked on a checkbox');
  ok('an edited-then-sent message counts as an approval',
    src.includes("d.decision === 'approve' || d.decision === 'modify'"),
    'editing a draft before sending it is still sending it, and the argument is what is being judged');
  ok('the confirmation is written through the audited config path',
    src.includes("'update_workspace_config'") && src.includes('proven_at'),
    'a raw policy write would skip the undo and the audit trail a person gets');
}

console.log(fail ? `\n${fail} FAILED\n` : '\nAll argument-trial assertions pass.\n');
process.exit(fail ? 1 : 0);
