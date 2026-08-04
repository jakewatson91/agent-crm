/**
 * Assertions for the out-of-scope veto.
 *
 * The veto is the one scoring path that DELETES a prospect from the book rather
 * than ranking it lower, so the cost of a false positive is a real account
 * silently lost. These assertions pin the guard that makes that hard: only a
 * condition number that lands inside the configured list can fire.
 *
 * Background: TVU Networks scored icp_fit 0.87 with industry_match 1.00 and was
 * drafted a CDN-offload pitch. They sell live video infrastructure to streaming
 * companies rather than operating a streaming service, and live is out of scope
 * for the product. No weighted dimension could have caught it — averaging a
 * fourth low sub-score into a 1.00 industry match still clears the 0.40 draft
 * bar. Hence a veto rather than a dimension.
 */
import { resolveOutOfScope, combineSubScores, type ScoreBreakdown } from '../packages/tools/src/scoring.ts';

let fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`}`);
  if (!ok) fail++;
}

const CONDITIONS = [
  'Their video is live only.',
  'They resell delivery rather than buying it.',
];

console.log('\nresolveOutOfScope — a veto fires only on a condition that exists:');

eq('nothing configured, nothing fires',
  resolveOutOfScope([], { condition: 1, evidence: 'x' }), null);
eq('no answer from the model is not a veto',
  resolveOutOfScope(CONDITIONS, null), null);
eq('explicit null is not a veto',
  resolveOutOfScope(CONDITIONS, undefined), null);
eq('missing condition number is not a veto',
  resolveOutOfScope(CONDITIONS, { evidence: 'sounds live to me' }), null);

eq('first condition fires and carries its evidence',
  resolveOutOfScope(CONDITIONS, { condition: 1, evidence: 'streaming_scale = live sports broadcast' }),
  'Their video is live only. — streaming_scale = live sports broadcast');
eq('last condition fires',
  resolveOutOfScope(CONDITIONS, { condition: 2, evidence: 'sells TVU One to broadcasters' }),
  'They resell delivery rather than buying it. — sells TVU One to broadcasters');
eq('a condition with no evidence still fires, unadorned',
  resolveOutOfScope(CONDITIONS, { condition: 1 }), 'Their video is live only.');

// The guard: an index outside the list means the model invented a condition.
eq('index past the end is dropped, not applied',
  resolveOutOfScope(CONDITIONS, { condition: 3, evidence: 'made this up' }), null);
eq('zero is dropped (the contract is 1-based)',
  resolveOutOfScope(CONDITIONS, { condition: 0, evidence: 'off-by-one' }), null);
eq('negative is dropped',
  resolveOutOfScope(CONDITIONS, { condition: -1 }), null);
eq('fractional index is dropped',
  resolveOutOfScope(CONDITIONS, { condition: 1.5 }), null);

// Long evidence is truncated so one bad quote can't bloat every stored breakdown.
const long = resolveOutOfScope(CONDITIONS, { condition: 1, evidence: 'x'.repeat(500) }) ?? '';
console.log(`  ${long.length <= CONDITIONS[0].length + 3 + 200 ? 'PASS' : 'FAIL'}  evidence truncated to 200 chars (len ${long.length})`);
if (long.length > CONDITIONS[0].length + 3 + 200) fail++;

// The reason this is a veto and not a fourth weighted dimension: TVU's real
// numbers, with a hypothetical 0.0 "serviceable" dimension averaged in, still
// clear the 0.40 draft bar. Only forcing the total to 0 stops the draft.
console.log('\nwhy a veto and not a weighted dimension (TVU Networks, 2026-07-31):');
const tvu: ScoreBreakdown = {
  industry_match: 1.00, stage_match: 0.40, signal_strength: 0.70,
  evidence_depth: 1.00, recency: 0.83, graph_proximity: 0.47, rrf_prefilter: 0.51,
};
const asScored = combineSubScores(tvu);
console.log(`  icp_total as actually scored: ${asScored.toFixed(2)} (drafted at the 0.40 bar)`);
console.log(`  ${asScored >= 0.40 ? 'PASS' : 'FAIL'}  reproduces a passing score from the real sub-scores`);
if (!(asScored >= 0.40)) fail++;
// Zeroing the weakest dimension outright is the most generous stand-in for
// "averaged a disqualifier in", and it still drafts.
const withZeroedDim = combineSubScores({ ...tvu, signal_strength: 0 });
console.log(`  same account with signal_strength zeroed: ${withZeroedDim.toFixed(2)}`);
console.log(`  ${withZeroedDim >= 0.40 ? 'PASS' : 'FAIL'}  still clears 0.40, so averaging cannot disqualify`);
if (!(withZeroedDim >= 0.40)) fail++;

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
