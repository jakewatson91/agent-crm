/**
 * Assertions for selectByBuckets — how the research budget splits.
 *
 * Exploration was raised from 15% to 50% of the budget on measured evidence:
 * never-researched accounts return a fresh dated event 2.2x as often as the ones
 * the dispatcher keeps re-reading. That is only safe because the share is
 * self-limiting — the explore pool is "never researched", so it empties as the
 * book gets covered and the spill hands the budget back. If that property ever
 * breaks, a covered workspace silently stops researching its best accounts.
 *   tsx scripts/check_selection_mix.ts   (exits non-zero on failure)
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { selectByBuckets, type Candidate } from '../inngest/functions/entity_research_dispatcher.ts';
import { DEFAULT_SELECTION_MIX } from '../packages/tools/src/policy.ts';

let fail = 0;
function ok(label: string, cond: boolean) {
  if (!cond) fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
}

const mix = { ...DEFAULT_SELECTION_MIX };
const cand = (id: string, o: Partial<Candidate> = {}): Candidate => ({
  entity_id: id, entity_name: id, tier: 'default', last_research_at: Date.now(),
  score: 0.8, engaged: false, under_covered: false, ...o,
});
const unread = (id: string, score = 0.7) => cand(id, { under_covered: true, last_research_at: 0, score });
const run = (cands: Candidate[], budget = 48) =>
  selectByBuckets(cands, { budget, mix, hotAngleCount: 3 });
const spend = (chosen: ReturnType<typeof run>) => chosen.reduce((n, c) => n + c.angle_count, 0);

console.log('\nThe default now puts half the budget on accounts never read once:');
ok('exploration is the largest bucket', DEFAULT_SELECTION_MIX.exploration >= 0.5);
ok('the three shares still sum to 1',
  Math.abs(DEFAULT_SELECTION_MIX.high_value + DEFAULT_SELECTION_MIX.active_comms + DEFAULT_SELECTION_MIX.exploration - 1) < 1e-9);

console.log('\nWith an uncovered book, unread accounts get a real share:');
const mixedBook = [
  ...Array.from({ length: 100 }, (_, i) => cand(`known-${i}`, { tier: 'hot', score: 0.9 })),
  ...Array.from({ length: 100 }, (_, i) => unread(`unread-${i}`)),
];
const picked = run(mixedBook);
const exploreCount = picked.filter((c) => c.cand.under_covered).length;
ok('unread accounts are actually picked', exploreCount > 0);
ok('and they are roughly half the spend, not a token sample', exploreCount >= 20);
ok('an unread account costs one search, not a deep pass',
  picked.filter((c) => c.cand.under_covered).every((c) => c.angle_count === 1));

console.log('\nSELF-LIMITING: a fully covered book spends nothing on exploration:');
// This is the property that makes the 50% safe. Without it, raising exploration
// would starve high-value research the moment a workspace finished its backlog.
const coveredBook = Array.from({ length: 100 }, (_, i) => cand(`known-${i}`, { tier: 'hot', score: 0.9 }));
const covered = run(coveredBook);
ok('nothing is left unspent when there is nowhere to explore', spend(covered) === 48);
ok('every search goes to a real account', covered.every((c) => !c.cand.under_covered));

console.log('\nThe budget is a ceiling in every case:');
ok('a mixed book never overspends', spend(picked) <= 48);
ok('a book of only unread accounts never overspends',
  spend(run(Array.from({ length: 500 }, (_, i) => unread(`u-${i}`)))) <= 48);
ok('a tiny budget still works', spend(run(mixedBook, 3)) <= 3);
ok('a zero budget picks nothing', run(mixedBook, 0).length === 0);
ok('an empty book picks nothing', run([]).length === 0);

console.log('\nNo account is researched twice in one dispatch:');
const both = [...Array.from({ length: 40 }, (_, i) => unread(`u-${i}`, 0.95))];
const dedup = run(both);
ok('a high-scoring unread account appears once, not in two buckets',
  new Set(dedup.map((c) => c.cand.entity_id)).size === dedup.length);

console.log('\nEngaged accounts still get their own share:');
const withEngaged = [
  ...Array.from({ length: 50 }, (_, i) => cand(`known-${i}`, { score: 0.9 })),
  ...Array.from({ length: 10 }, (_, i) => cand(`talking-${i}`, { engaged: true, score: 0.2 })),
  ...Array.from({ length: 50 }, (_, i) => unread(`unread-${i}`)),
];
ok('an account mid-conversation is picked despite a low score',
  run(withEngaged).some((c) => c.cand.engaged));

console.log(fail === 0 ? '\nOK: selection mix assertions passed' : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
