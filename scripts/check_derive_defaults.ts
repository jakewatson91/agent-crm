/**
 * Assertions for the setup wizard's derived workspace defaults.
 *
 * Every field `sanitizeDerived` returns is written straight onto workspaces.policy
 * and inherited silently by a customer who never opens Settings, so the clamping
 * is the part worth pinning — not the model's wording, which changes run to run.
 *
 * The one that actually bites is `out_of_scope`. It is a veto: a matching account
 * goes to icp_total 0 and leaves the book, so an enthusiastic model can empty a
 * shortlist at setup time and the symptom is "the agent found nobody", which
 * nobody debugs back to a wizard guess. Hence a cap, a dedupe, and a UI field.
 */
import { sanitizeDerived, EMPTY } from '../apps/web/app/api/workspaces/_derive_defaults.ts';

let fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`}`);
  if (!ok) fail++;
}

console.log('\nA model that returns nothing usable still yields a safe workspace:');
eq('empty object → defaults', sanitizeDerived({}), EMPTY);
eq('null → defaults', sanitizeDerived(null), EMPTY);
eq('no out-of-scope condition is the default', EMPTY.out_of_scope, []);

console.log('\nout_of_scope is capped, deduped and string-only:');
eq('five conditions are cut to four',
  sanitizeDerived({ out_of_scope: ['a', 'b', 'c', 'd', 'e'] }).out_of_scope, ['a', 'b', 'c', 'd']);
eq('duplicates collapse',
  sanitizeDerived({ out_of_scope: ['a', 'a', 'b'] }).out_of_scope, ['a', 'b']);
eq('blanks and non-strings are dropped',
  sanitizeDerived({ out_of_scope: ['a', '', '   ', 7, null] }).out_of_scope, ['a']);
eq('a bare string is not a list of conditions',
  sanitizeDerived({ out_of_scope: 'they resell' }).out_of_scope, []);

console.log('\nNews windows stay inside ranges that leave both message modes reachable:');
eq('a fresh window of 0 is raised to the floor', sanitizeDerived({ trigger_fresh_days: 0 }).trigger_fresh_days, 3);
eq('a fresh window of 9999 is cut to the ceiling', sanitizeDerived({ trigger_fresh_days: 9999 }).trigger_fresh_days, 60);
eq('a dead window of 9999 is cut to the ceiling', sanitizeDerived({ trigger_max_age_days: 9999 }).trigger_max_age_days, 365);
eq('fractions round to whole days', sanitizeDerived({ trigger_fresh_days: 21.6 }).trigger_fresh_days, 22);
eq('a string is not a day count', sanitizeDerived({ trigger_fresh_days: '30' }).trigger_fresh_days, 14);
// A dead window shorter than the fresh window means no event can be both recent
// enough to lead with and inside the window that keeps it alive: mode A would be
// unreachable and every message would be theme-led.
const inverted = sanitizeDerived({ trigger_fresh_days: 45, trigger_max_age_days: 20 });
eq('dead window is never shorter than fresh', inverted.trigger_max_age_days, 45);
eq('  and the fresh window it was raised to is kept', inverted.trigger_fresh_days, 45);

console.log('\nLanguage falls back rather than emitting an empty rule:');
eq('a real language passes through', sanitizeDerived({ outreach_language: 'German' }).outreach_language, 'German');
eq('whitespace falls back', sanitizeDerived({ outreach_language: '   ' }).outreach_language, 'English');
eq('a non-string falls back', sanitizeDerived({ outreach_language: 42 }).outreach_language, 'English');

console.log('\nThe existing derived fields still survive the same coercion:');
const d = sanitizeDerived({
  pain_points: ['Invoices go out late.', '', 'Crews wait on paperwork.'],
  example_facts: [{ predicate: 'p', object_text: 'o' }, { predicate: 'bad' }],
  constitution: 'be plain',
});
eq('blank pain points dropped', d.pain_points, ['Invoices go out late.', 'Crews wait on paperwork.']);
eq('half-formed example facts dropped', d.example_facts, [{ predicate: 'p', object_text: 'o' }]);
eq('constitution passes through', d.constitution, 'be plain');

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
