/**
 * Tests for the account-driven advance pass (inngest/functions/advance_accounts.ts).
 *
 * No formal runner in this repo — this is a tsx assertion script (same shape as
 * scripts/_test_action_routing.ts). Run: `npx tsx scripts/test_advance.ts`.
 * Exits non-zero on the first failed assertion.
 *
 * Focus: the pause classifier. It decides whether a provider/LLM error HALTS the
 * whole run (out of money / bad key — the next account fails the same way) or is
 * a benign per-account skip (no domain, matched-but-found-nobody, a network
 * blip). A false negative here means we drain credits against an empty balance;
 * a false positive means one bad account needlessly pauses the whole pipeline.
 */
import { isHaltingError } from '../inngest/functions/advance_accounts.js';

let failures = 0;
function expect(msg: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (!ok) { failures++; console.error(`  FAIL ${msg}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`); }
  else console.log(`  ok   ${msg}`);
}

console.log('isHaltingError — should HALT (credit / quota / auth):');
for (const m of [
  'Hunter 402: Insufficient Balance',
  'DeepSeek error: Insufficient Balance',
  'insufficient_quota',
  'You exceeded your current quota',
  'Explorium prospects 429: Too Many Requests',
  'rate limit reached',
  '401 Unauthorized',
  'invalid api key',
  'Payment Required',
  'your credit balance is too low',
]) expect(`halt "${m.slice(0, 32)}"`, isHaltingError(m), true);

console.log('\nisHaltingError — should SKIP (benign, per-account):');
for (const m of [
  'no domain on account',
  'no contacts found via explorium/hunter',
  'Explorium match 200: no business found',
  'some transient network ECONNRESET',
  'matched, found nobody',
  'LLM returned non-JSON: {partial',
  '',
]) expect(`skip "${m.slice(0, 32)}"`, isHaltingError(m), false);

// undefined must be safe (no error string → not halting)
expect('skip undefined', isHaltingError(undefined), false);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
