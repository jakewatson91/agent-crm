/**
 * Assertions for the empty-run research backoff.
 *
 * The dispatcher already backed off on `signal_strength`, which is what we
 * BELIEVE about an account. This second backoff reads what the searches actually
 * returned, which is a different thing — an account can score well off imported
 * facts and have nothing findable about it on the open web.
 *
 * The trigger of two is measured, not chosen. Over 90 days of the Sudden book
 * (1,354 runs, `scripts/_sim_empty_yield.ts`), a run whose predecessor found
 * nothing still produced 0.46 facts per search against a 0.58 baseline — near
 * enough to normal that throttling after one empty pass would slow down accounts
 * that were still paying. After two, yield fell to 0.21. So one empty run must
 * NOT back off and two must, and that boundary is what these pin.
 *
 * The cap matters for the opposite reason: multipliers land on a cold tier whose
 * cadence is already 30 days, so an uncapped ladder silently retires accounts.
 */
import {
  emptyRunBackoff, DEFAULT_EMPTY_RUN_BACKOFF_MAX, EMPTY_RUN_BACKOFF_TRIGGER,
  type WorkspacePolicy,
} from '../packages/tools/src/policy.ts';

let fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`}`);
  if (!ok) fail++;
}

const P = (research?: Record<string, unknown>): WorkspacePolicy => ({ research } as WorkspacePolicy);
const dflt = P();

console.log('\nOne empty pass is noise and must not slow the account down:');
eq('never researched → no change', emptyRunBackoff(0, dflt), 1);
eq('one empty run → no change', emptyRunBackoff(1, dflt), 1);
eq('the measured trigger is still 2', EMPTY_RUN_BACKOFF_TRIGGER, 2);

console.log('\nTwo empty passes in a row is where measured yield collapses:');
eq('two empty runs → 2x', emptyRunBackoff(2, dflt), 2);
eq('three empty runs → 3x', emptyRunBackoff(3, dflt), 3);
eq('four empty runs → 4x', emptyRunBackoff(4, dflt), 4);

console.log('\nThe ladder is capped, so a quiet account is never retired outright:');
eq('ten empty runs is still 4x', emptyRunBackoff(10, dflt), DEFAULT_EMPTY_RUN_BACKOFF_MAX);
eq('a hundred empty runs is still 4x', emptyRunBackoff(100, dflt), DEFAULT_EMPTY_RUN_BACKOFF_MAX);
eq('the default cap is 4', DEFAULT_EMPTY_RUN_BACKOFF_MAX, 4);
// 4x on the 30-day cold tier is 120 days. The account still comes back around,
// which is the whole difference between backing off and dropping.
eq('a workspace can raise the cap', emptyRunBackoff(6, P({ empty_run_backoff_max: 6 })), 6);
eq('and its own cap still binds', emptyRunBackoff(99, P({ empty_run_backoff_max: 6 })), 6);

console.log('\nA customer can switch the whole behavior off from settings:');
eq('max 1 → off', emptyRunBackoff(9, P({ empty_run_backoff_max: 1 })), 1);
eq('max 0 → off', emptyRunBackoff(9, P({ empty_run_backoff_max: 0 })), 1);
eq('a negative cap is off, not inverted', emptyRunBackoff(9, P({ empty_run_backoff_max: -5 })), 1);

console.log('\nJunk config falls back to the default rather than disabling the rule:');
eq('unset research block → default ladder', emptyRunBackoff(3, {} as WorkspacePolicy), 3);
eq('a string cap is ignored', emptyRunBackoff(3, P({ empty_run_backoff_max: '2' })), 3);
eq('NaN is ignored', emptyRunBackoff(3, P({ empty_run_backoff_max: Number.NaN })), 3);
eq('a fractional cap floors', emptyRunBackoff(9, P({ empty_run_backoff_max: 2.9 })), 2);

console.log('\nA junk run count can never turn the multiplier into a divider:');
eq('negative run count → no change', emptyRunBackoff(-3, dflt), 1);
eq('NaN run count → no change', emptyRunBackoff(Number.NaN, dflt), 1);
eq('a fractional run count floors', emptyRunBackoff(2.9, dflt), 2);

if (fail) { console.error(`\nFAILED: ${fail} empty-run backoff assertion(s)`); process.exit(1); }
console.log('\nOK: empty-run backoff assertions passed');
