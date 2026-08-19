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

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
