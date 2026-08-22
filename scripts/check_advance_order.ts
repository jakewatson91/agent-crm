/**
 * Assertions for compareWalkOrder — the order the daily advance pass walks
 * accounts in.
 *
 * The pass caps at 400 accounts and does nothing for one that misses the draft
 * bars, so this comparator decides which accounts get acted on at all. Sorting it
 * on `tot` alone reached 51 of the 67 draftable accounts on the live Sudden book
 * and never saw the other 16. Run after any change to the walk or the thresholds:
 *   tsx scripts/check_advance_order.ts   (exits non-zero on failure)
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { compareWalkOrder, type Scored } from '../inngest/functions/advance_accounts.ts';
import { DEFAULT_THRESHOLDS } from '../packages/tools/src/action_selector.ts';

const T = DEFAULT_THRESHOLDS;
const clearsGates = (s: Scored) =>
  s.tot >= T.DRAFT_ICP_TOTAL && !!s.anchor && s.ev >= T.DRAFT_EVIDENCE_DEPTH;
const cmp = (a: Scored, b: Scored) => compareWalkOrder(a, b, clearsGates);
const sort = (xs: Scored[]) => [...xs].sort(cmp);

let fail = 0;
function ok(label: string, cond: boolean) {
  if (!cond) fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
}
// `anchor` is the reason-to-write flag: a dated event inside the freshness
// window. It replaced signal_strength as the thing the draft bar tests, so the
// cases below set it rather than a high `sig`, which now only breaks ties.
const acc = (entity_id: string, tot: number, anchor: boolean, ev: number, sig = 0.4): Scored =>
  ({ entity_id, tot, sig, ev, anchor });

console.log('compareWalkOrder:');

// 1. The whole point: an account that clears every bar outranks a higher-`tot`
//    account with no reason to write. This is the case the old `tot` sort got
//    wrong, and the anchor is now what "reason to write" means.
const draftable = acc('draftable', 0.70, true, 0.83);
const highFitNoAnchor = acc('high-fit', 0.95, false, 1.00);
ok('a gate-clearing account outranks a higher-scoring one with nothing happening',
  sort([highFitNoAnchor, draftable])[0]!.entity_id === 'draftable');

// 2. A real dated event outranks fit even when another bar is short (evidence
//    here), because a contact pull or one more fact can still unlock it this run.
const anchorThinEvidence = acc('anchor-thin', 0.70, true, 0.33);
ok('a dated event outranks fit even when evidence is short',
  sort([highFitNoAnchor, anchorThinEvidence])[0]!.entity_id === 'anchor-thin');

// 3. A high signal_strength no longer buys a place. That score called a signed
//    nine-channel European distribution deal "passive presence" at 0.4 while
//    giving 0.70 to launches the drafter then refused to use.
ok('signal_strength alone does not outrank a real dated event',
  sort([acc('loud-score', 0.90, false, 1.0, 0.95), anchorThinEvidence])[0]!.entity_id === 'anchor-thin');

// 4. Among accounts that all clear the bars, the stronger signal still breaks the
//    tie. That is the only job it has left here.
ok('strongest signal first among gate-clearers',
  sort([acc('s7', 0.90, true, 1.0, 0.70), acc('s10', 0.70, true, 1.0, 1.00)])[0]!.entity_id === 's10');

// 5. With nothing happening anywhere, it degrades to exactly the old behaviour: by fit.
const quiet = [acc('a', 0.70, false, 1.0), acc('b', 0.90, false, 1.0), acc('c', 0.80, false, 1.0)];
ok('falls back to fit order when nothing has happened to anyone',
  sort(quiet).map((s) => s.entity_id).join('') === 'bca');

// 6. The 1,060-way tie: identical scores must still produce a fixed order rather
//    than depending on the order rows arrived in.
const tie = [acc('zz', 0.84, false, 0.83), acc('aa', 0.84, false, 0.83), acc('mm', 0.84, false, 0.83)];
ok('a full tie sorts deterministically', sort(tie).map((s) => s.entity_id).join('') === 'aammzz');
ok('a full tie sorts the same from a different input order',
  sort([...tie].reverse()).map((s) => s.entity_id).join('') === 'aammzz');

// 7. NaN safety. loadCurrentScores only requires `tot` to parse, so `sig`/`ev`
//    can be NaN. A NaN comparator result makes the entire sort undefined.
const nanSig = acc('nan', 0.90, false, NaN, NaN);
ok('a NaN signal never returns NaN from the comparator',
  Number.isFinite(cmp(nanSig, draftable)) && Number.isFinite(cmp(draftable, nanSig)));
ok('a NaN signal ranks below a real anchor', sort([nanSig, draftable])[0]!.entity_id === 'draftable');
ok('a NaN signal still beats nothing and stays in the list', sort([nanSig]).length === 1);

// 8. An unset `anchor` means false, never "unknown". The field is optional on
//    Scored, so a caller that has not been updated has to degrade to fit order
//    rather than making every account in the book look actionable.
const noFlag: Scored = { entity_id: 'unflagged', tot: 0.90, sig: 0.9, ev: 1.0 };
ok('an account with no anchor flag ranks below one that has an anchor',
  sort([noFlag, draftable])[0]!.entity_id === 'draftable');
ok('and it never clears the gates', clearsGates(noFlag) === false);

// 9. The comparator must be a valid total order, or Array.sort is free to do
//    anything: antisymmetric, and never claiming two different accounts are equal.
const pool = [draftable, highFitNoAnchor, anchorThinEvidence, nanSig, noFlag, ...tie];
let antisym = true, noFalseTies = true;
for (const a of pool) for (const b of pool) {
  if (Math.sign(cmp(a, b)) !== -Math.sign(cmp(b, a))) antisym = false;
  if (a.entity_id !== b.entity_id && cmp(a, b) === 0) noFalseTies = false;
}
ok('comparator is antisymmetric', antisym);
ok('no two distinct accounts compare equal', noFalseTies);

// 10. Transitivity across the whole pool, since the rank is built from several
//     keys and a mistake in one of them shows up here rather than as a rare
//     mis-sort in production.
let transitive = true;
for (const a of pool) for (const b of pool) for (const c of pool) {
  if (cmp(a, b) < 0 && cmp(b, c) < 0 && !(cmp(a, c) < 0)) transitive = false;
}
ok('comparator is transitive', transitive);

// 11. The cap is what makes order matter: with more gate-clearers than slots, the
//     slots must go to gate-clearers. Mirrors the live shape — a few actionable
//     accounts buried in a large tie of unresearched CSV rows.
const book: Scored[] = [
  ...Array.from({ length: 500 }, (_, i) => acc(`tied-${String(i).padStart(4, '0')}`, 0.84, false, 0.83)),
  ...Array.from({ length: 12 }, (_, i) => acc(`ready-${i}`, 0.66, true, 0.83)),
];
const walked = sort(book).slice(0, 400);
ok('every gate-clearer survives the 400 cap, buried in a 500-way tie',
  walked.filter((s) => s.entity_id.startsWith('ready-')).length === 12);
ok('gate-clearers come first, before any of the tie',
  walked.slice(0, 12).every((s) => s.entity_id.startsWith('ready-')));

// 12. Freshness. The draft cap is what makes this matter: on a day with more
//     draftable accounts than slots, the slots have to go to the events that are
//     about to expire, not to the best-fitting company. Everything else the
//     comparator ranks on is a property of the company and reads the same
//     tomorrow; how old the event is does not.
const dated = (entity_id: string, tot: number, daysAgo: number, ev = 0.83, sig = 0.4): Scored =>
  ({ entity_id, tot, sig, ev, anchor: true, anchorAt: new Date(Date.now() - daysAgo * 86400e3).toISOString() });

const yesterday = dated('yesterday', 0.66, 1);
const lastMonth = dated('last-month', 0.98, 28, 1.0, 0.99);
ok('a day-old event outranks a four-week-old one at a better-fitting account',
  sort([lastMonth, yesterday])[0]!.entity_id === 'yesterday');

ok('freshness orders the whole queue, newest first',
  sort([dated('d20', 0.9, 20), dated('d2', 0.7, 2), dated('d9', 0.8, 9)])
    .map((s) => s.entity_id).join(' ') === 'd2 d9 d20');

// 13. Freshness sits BELOW the bars, not above them. A fresh event at an account
//     that cannot be drafted is still worth less than a stale one at an account
//     that can, because the pass does nothing at all for the first.
const freshButBlocked: Scored = { entity_id: 'fresh-blocked', tot: 0.66, sig: 0.4, ev: 0.10, anchor: true, anchorAt: new Date().toISOString() };
ok('a gate-clearer with a stale event still outranks a fresh event that clears nothing',
  sort([freshButBlocked, dated('stale-ready', 0.66, 29)])[0]!.entity_id === 'stale-ready');
ok('and the fresh blocked account really does miss the gates', clearsGates(freshButBlocked) === false);

// 14. A caller that sets `anchor` and not `anchorAt` must keep working. Unknown
//     age ranks last among gate-clearers rather than anywhere in the middle,
//     which is the same fail-closed reading NaN gets above.
const undatedAnchor = acc('undated', 0.99, true, 1.0, 0.99);
ok('an anchor with no date ranks below one with a date',
  sort([undatedAnchor, dated('has-date', 0.66, 29)])[0]!.entity_id === 'has-date');
ok('two undated anchors still fall through to signal then fit',
  sort([acc('u-lo', 0.70, true, 1.0, 0.20), acc('u-hi', 0.70, true, 1.0, 0.90)])[0]!.entity_id === 'u-hi');

// 15. An unparseable date must not poison the sort. `happened_at` is written by
//     the enricher, a backfill script and a CSV import, so a junk value reaching
//     here is a question of when, not whether.
const junkDate: Scored = { entity_id: 'junk', tot: 0.70, sig: 0.4, ev: 0.83, anchor: true, anchorAt: 'not a date' };
ok('a junk date never returns NaN from the comparator',
  Number.isFinite(cmp(junkDate, yesterday)) && Number.isFinite(cmp(yesterday, junkDate)));
ok('a junk date ranks below a real one', sort([junkDate, dated('real', 0.66, 29)])[0]!.entity_id === 'real');

// 16. The total-order properties again, now with dates in the pool. A new key in
//     the comparator is exactly how transitivity gets broken.
const datedPool = [...pool, yesterday, lastMonth, freshButBlocked, undatedAnchor, junkDate, dated('d5', 0.5, 5)];
let dAnti = true, dTies = true, dTrans = true;
for (const a of datedPool) for (const b of datedPool) {
  if (Math.sign(cmp(a, b)) !== -Math.sign(cmp(b, a))) dAnti = false;
  if (a.entity_id !== b.entity_id && cmp(a, b) === 0) dTies = false;
}
for (const a of datedPool) for (const b of datedPool) for (const c of datedPool) {
  if (cmp(a, b) < 0 && cmp(b, c) < 0 && !(cmp(a, c) < 0)) dTrans = false;
}
ok('comparator is still antisymmetric with dates in play', dAnti);
ok('no two distinct dated accounts compare equal', dTies);
ok('comparator is still transitive with dates in play', dTrans);

// 17. The live shape: twelve slots, sixty draftable accounts, and the fresh ones
//     scattered through a fit-ordered book. This is the case that was losing.
const queue: Scored[] = [
  ...Array.from({ length: 60 }, (_, i) => dated(`old-${String(i).padStart(2, '0')}`, 0.95, 20 + (i % 8))),
  ...Array.from({ length: 5 }, (_, i) => dated(`new-${i}`, 0.66, 1)),
];
ok('all five fresh events make the twelve-draft cut, ahead of sixty better-fitting stale ones',
  sort(queue).slice(0, 12).filter((s) => s.entity_id.startsWith('new-')).length === 5);

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
