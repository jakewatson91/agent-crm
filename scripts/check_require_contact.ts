/**
 * Assertions for REQUIRE_CONTACT — must we know a named person before drafting?
 *
 * It is not a preference, it follows from the channel: email cannot send to
 * nobody, and on LinkedIn the person is found inside LinkedIn for free. Getting
 * it wrong in the safe direction costs half the book (35 of 67 accounts that
 * cleared every bar on Sudden had nobody attached, and queued nightly for a pull
 * that returned nothing). Getting it wrong the other way emails a void.
 *   tsx scripts/check_require_contact.ts   (exits non-zero on failure)
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { buildThresholds, selectAction, DEFAULT_THRESHOLDS } from '../packages/tools/src/action_selector.ts';

let fail = 0;
function ok(label: string, cond: boolean) {
  if (!cond) fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
}

console.log('\nThe channel decides, not a separate question at setup:');
ok('email requires a contact', buildThresholds(undefined, 'email').REQUIRE_CONTACT === true);
ok('linkedin does not', buildThresholds(undefined, 'linkedin').REQUIRE_CONTACT === false);
ok('an unset channel is email, the default channel',
  buildThresholds(undefined, undefined).REQUIRE_CONTACT === true);
ok('the default thresholds require one', DEFAULT_THRESHOLDS.REQUIRE_CONTACT === true);

console.log('\nAn explicit setting still wins, for anyone whose setup differs:');
ok('linkedin can be forced back on',
  buildThresholds({ require_contact: true }, 'linkedin').REQUIRE_CONTACT === true);
ok('email can be switched off',
  buildThresholds({ require_contact: false }, 'email').REQUIRE_CONTACT === false);

console.log('\nRouting: the same account, the same facts, two channels:');
const breakdown = {
  industry_match: 0.9, stage_match: 0.9, signal_strength: 0.4,
  evidence_depth: 0.83, recency: 0.8, graph_proximity: 0, rrf_prefilter: 0,
};
// A real account shape from the live book: clears fit and evidence, has a dated
// event, and nobody on file. signal_strength is 0.4 on purpose — the score that
// used to gate this is the one that called a signed distribution deal "passive
// presence", and the anchor is what decides now.
const base = {
  workspace_id: 'w', entity_id: 'e', breakdown, icp_total: 0.84,
  best_contact_score: undefined,
  recent_draft_at: null, recent_research_at: '2026-08-01T00:00:00Z',
  recent_contacts_request_at: null, dropped_until: null, cooldown_until: null,
  has_anchor: true,
};
const onEmail = selectAction({ ...base, thresholds: buildThresholds(undefined, 'email') });
const onLinkedIn = selectAction({ ...base, thresholds: buildThresholds(undefined, 'linkedin') });
ok('email goes and buys a contact first', onEmail.action === 'enrich_contacts');
ok('linkedin drafts to the company', onLinkedIn.action === 'draft_outreach');

console.log('\nDropping the requirement does not drop the other bars:');
ok('no anchor still means no draft',
  selectAction({ ...base, has_anchor: false, thresholds: buildThresholds(undefined, 'linkedin') }).action !== 'draft_outreach');
ok('thin evidence still means no draft',
  selectAction({
    ...base, breakdown: { ...breakdown, evidence_depth: 0.1 },
    thresholds: buildThresholds(undefined, 'linkedin'),
  }).action !== 'draft_outreach');
ok('a poor fit still means no draft',
  selectAction({ ...base, icp_total: 0.4, thresholds: buildThresholds(undefined, 'linkedin') }).action !== 'draft_outreach');
ok('the suppression window still holds',
  selectAction({
    ...base, recent_draft_at: new Date(Date.now() - 86400_000).toISOString(),
    thresholds: buildThresholds(undefined, 'linkedin'),
  }).action !== 'draft_outreach');

console.log('\nAnd a weak contact stops blocking a channel that never needed one:');
ok('a below-bar contact does not block a linkedin draft',
  selectAction({ ...base, best_contact_score: 0.2, thresholds: buildThresholds(undefined, 'linkedin') }).action === 'draft_outreach');
ok('but it does on email',
  selectAction({ ...base, best_contact_score: 0.2, thresholds: buildThresholds(undefined, 'email') }).action === 'enrich_contacts');

console.log('\nNo reason to write routes to research, which is the point:');
ok('an account with no anchor goes looking for one',
  selectAction({ ...base, has_anchor: false, thresholds: buildThresholds(undefined, 'linkedin') }).action === 'deep_research');

console.log('\nAnd when research is on cooldown, the watch reason names the real blocker:');
// Research just ran, so the account falls through to watch_only and the reason
// string is the only record of why no draft happened. It must not blame a
// missing contact on a channel that never wanted one — that is the audit trail a
// human reads when asking "why is nothing coming out of this account".
const watched = selectAction({
  ...base, has_anchor: false,
  recent_research_at: new Date(Date.now() - 86400_000).toISOString(),
  thresholds: buildThresholds(undefined, 'linkedin'),
});
ok('it watches rather than re-researching', watched.action === 'watch_only');
ok('no contact complaint on linkedin', !watched.reason.includes('contact'));
ok('it names the real blocker instead', watched.reason.includes('nothing dated has happened'));
ok('and on email the missing contact IS named',
  selectAction({
    ...base, has_anchor: false,
    recent_research_at: new Date(Date.now() - 86400_000).toISOString(),
    thresholds: buildThresholds(undefined, 'email'),
  }).reason.includes('no scored contact'));

console.log(fail === 0 ? '\nOK: require_contact assertions passed' : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
