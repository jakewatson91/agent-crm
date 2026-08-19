/**
 * Assertions for pickAnchorCandidates — the test that decides whether we write
 * to a company at all.
 *
 * This replaced a score, and the reason it replaced it is that a score can
 * disagree with the message: Wedotv cleared the bar at signal_strength 0.70 on
 * launches the drafter then refused to use, and opened on the company
 * description instead. So the rules below are the product, not plumbing.
 *   tsx scripts/check_anchor.ts   (exits non-zero on failure)
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { pickAnchorCandidates, cannotWriteAbout, DEFAULT_ANCHOR_FRESH_DAYS, type AnchorCandidate } from '../packages/tools/src/anchor.ts';

let fail = 0;
function ok(label: string, cond: boolean) {
  if (!cond) fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
}

const NOW = Date.UTC(2026, 7, 18);
const daysAgo = (n: number) => new Date(NOW - n * 86400_000).toISOString();
const fact = (id: string, happened_at: string | null, object_text = `something ${id}`): AnchorCandidate =>
  ({ id, predicate: 'recent_launch', object_text, happened_at });
const pick = (facts: AnchorCandidate[], extra: { usedFactIds?: string[]; freshDays?: number } = {}) =>
  pickAnchorCandidates({ facts, now: NOW, ...extra });

console.log('\nAn anchor has to be something that HAPPENED:');
// This is the Wedotv line. A company description sitting on a dated page is not
// a reason to write, however fresh the page is.
ok('an undated fact is never an anchor', pick([fact('state', null)]).candidates.length === 0);
ok('and it is counted as such, not silently dropped',
  pick([fact('state', null)]).rejected.not_an_event === 1);
ok('a dated event is an anchor', pick([fact('launch', daysAgo(3))]).candidates.length === 1);

console.log('\nFreshness is a window, and it is config:');
ok(`inside the ${DEFAULT_ANCHOR_FRESH_DAYS}-day default is in`, pick([fact('a', daysAgo(29))]).candidates.length === 1);
ok('outside it is out', pick([fact('a', daysAgo(31))]).candidates.length === 0);
ok('the window is configurable', pick([fact('a', daysAgo(31))], { freshDays: 60 }).candidates.length === 1);
ok('a zero or negative window falls back to the default rather than blocking everything',
  pick([fact('a', daysAgo(5))], { freshDays: 0 }).candidates.length === 1);
ok('an event dated today is in', pick([fact('a', daysAgo(0))]).candidates.length === 1);

console.log('\nAn anchor is spent once we have written about it:');
ok('a fact already cited to this account is not an anchor again',
  pick([fact('used', daysAgo(2))], { usedFactIds: ['used'] }).candidates.length === 0);
ok('but a second, unused event still is',
  pick([fact('used', daysAgo(2)), fact('fresh', daysAgo(4))], { usedFactIds: ['used'] })
    .candidates.map((c) => c.id).join('') === 'fresh');

console.log('\nFreshest first, and the same order every run:');
const three = [fact('old', daysAgo(20)), fact('newest', daysAgo(1)), fact('mid', daysAgo(10))];
ok('freshest leads', pick(three).candidates[0]!.id === 'newest');
ok('then the next freshest', pick(three).candidates.map((c) => c.id).join(',') === 'newest,mid,old');
const sameDay = [fact('zz', daysAgo(2)), fact('aa', daysAgo(2)), fact('mm', daysAgo(2))];
ok('two events on the same day do not shuffle between runs',
  pick(sameDay).candidates.map((c) => c.id).join('') === pick([...sameDay].reverse()).candidates.map((c) => c.id).join(''));

console.log('\nJunk fails closed. An unreadable date must not read as fresh:');
ok('an unparseable date is not an anchor', pick([fact('bad', 'not-a-date')]).candidates.length === 0);
ok('and it is reported as its own kind of reject',
  pick([fact('bad', 'not-a-date')]).rejected.unreadable_date === 1);
ok('a fact with no text is not an anchor', pick([fact('empty', daysAgo(1), '')]).candidates.length === 0);
ok('nor is one that is only whitespace', pick([fact('ws', daysAgo(1), '   ')]).candidates.length === 0);

console.log('\nNothing to write about is a normal, countable outcome:');
const quiet = pick([fact('a', null), fact('b', daysAgo(90)), fact('c', null)]);
ok('no candidates', quiet.candidates.length === 0);
ok('and the tally says why', quiet.rejected.not_an_event === 2 && quiet.rejected.older_than_window === 1);
ok('considered counts everything it looked at', quiet.considered === 3);
ok('an account with no facts at all is handled', pick([]).candidates.length === 0);

console.log('\ncannotWriteAbout falls back so the split does not switch off an existing rule:');
ok('its own field wins',
  cannotWriteAbout({ cannot_write_about: ['no live sport'], out_of_scope: ['live only'] }).join('') === 'no live sport');
ok('an unset field falls back to out_of_scope',
  cannotWriteAbout({ out_of_scope: ['live only'] }).join('') === 'live only');
ok('an empty array falls back too, since it reads as unset',
  cannotWriteAbout({ cannot_write_about: [], out_of_scope: ['live only'] }).join('') === 'live only');
ok('blank strings do not count as a condition',
  cannotWriteAbout({ cannot_write_about: ['  '], out_of_scope: ['live only'] }).join('') === 'live only');
ok('nothing configured is nothing', cannotWriteAbout({}).length === 0);
ok('undefined is handled', cannotWriteAbout().length === 0);

console.log(fail === 0 ? '\nOK: anchor assertions passed' : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
