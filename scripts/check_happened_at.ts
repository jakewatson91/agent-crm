/**
 * Assertions for resolveHappenedAt — when the thing in a fact actually happened.
 *
 * This is the one place that answers a question three parts of the system used
 * to work out separately, and all three had the same failure: an unknown date
 * quietly becoming today. Every case below is that bug trying to come back.
 *   tsx scripts/check_happened_at.ts   (exits non-zero on failure)
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { resolveHappenedAt } from '../packages/tools/src/published_date.ts';

let fail = 0;
function ok(label: string, cond: boolean) {
  if (!cond) fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
}
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : null);

console.log('\nA fact that is not an event has no date, whatever dates are around:');
// The Wedotv failure in one line. The page had a publication date; the
// description of the company printed on it still did not happen that day.
ok('state on a dated page is undated',
  resolveHappenedAt({ isEvent: false, eventDate: '', sourceDate: '2026-08-01T00:00:00.000Z' }) === null);
ok('state with a date the model volunteered anyway is still undated',
  resolveHappenedAt({ isEvent: false, eventDate: '2026-08-01', sourceDate: '2026-08-01T00:00:00.000Z' }) === null);
ok('an unset is_event reads as not an event',
  resolveHappenedAt({ isEvent: undefined, eventDate: '2026-08-01', sourceDate: '2026-08-01' }) === null);

console.log('\nAn event uses the date the page stated for it:');
ok('a stated event date wins',
  day(resolveHappenedAt({ isEvent: true, eventDate: '2026-07-04', sourceDate: '2026-08-01' })) === '2026-07-04');
ok('and it wins even when it is older than the page',
  day(resolveHappenedAt({ isEvent: true, eventDate: '2024-01-15', sourceDate: '2026-08-01' })) === '2024-01-15');

console.log('\nAn undated event falls back to the page, in both stored shapes:');
// The fallback is the whole reason coverage is 77% rather than a handful: a news
// story reporting a signed deal dates the deal to within days.
ok('a bare day from the model is accepted',
  day(resolveHappenedAt({ isEvent: true, eventDate: '', sourceDate: '2026-08-01' })) === '2026-08-01');
ok('a full ISO timestamp, which is how it is stored, is accepted',
  day(resolveHappenedAt({ isEvent: true, eventDate: '', sourceDate: '2026-08-01T09:30:00.000Z' })) === '2026-08-01');
ok('a null event_date behaves the same as an empty one',
  day(resolveHappenedAt({ isEvent: true, eventDate: null, sourceDate: '2026-08-01' })) === '2026-08-01');

console.log('\nAn event nobody can date stays undated. This is the line that closes the bug class:');
ok('no stated date and no page date is null, NOT today',
  resolveHappenedAt({ isEvent: true, eventDate: '', sourceDate: null }) === null);
ok('an empty-string page date is null too',
  resolveHappenedAt({ isEvent: true, eventDate: '', sourceDate: '' }) === null);

console.log('\nJunk dates are refused rather than half-read:');
ok('a page-format date the prompt failed to convert is refused',
  resolveHappenedAt({ isEvent: true, eventDate: '23/04/2026', sourceDate: null }) === null);
ok('a word is refused', resolveHappenedAt({ isEvent: true, eventDate: 'unknown', sourceDate: null }) === null);
ok('a year alone is refused', resolveHappenedAt({ isEvent: true, eventDate: '2026', sourceDate: null }) === null);
ok('a month with no day is refused', resolveHappenedAt({ isEvent: true, eventDate: '2026-08', sourceDate: null }) === null);
ok('an impossible day is refused', resolveHappenedAt({ isEvent: true, eventDate: '2026-02-31', sourceDate: null }) === null);
ok('a junk event date falls through to the page rather than losing the fact',
  day(resolveHappenedAt({ isEvent: true, eventDate: 'last Tuesday', sourceDate: '2026-08-01' })) === '2026-08-01');

console.log('\nA date that cannot be real is a misread, not a fact:');
const nextYear = new Date(Date.now() + 400 * 86400_000).toISOString().slice(0, 10);
ok('a date well in the future is refused',
  resolveHappenedAt({ isEvent: true, eventDate: nextYear, sourceDate: null }) === null);
ok('a pre-web date is refused',
  resolveHappenedAt({ isEvent: true, eventDate: '1970-01-01', sourceDate: null }) === null);

console.log(fail === 0 ? '\nOK: happened_at assertions passed' : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
