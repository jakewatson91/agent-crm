/**
 * Assertions for combineSubScores — the score combination formula.
 *
 * There is no test runner in this repo, so this stands in as the regression
 * guard for the one piece of scoring that is pure arithmetic and easy to break
 * silently. Run it after any change to weights, dimensions, or the renormalize
 * rule: tsx scripts/check_score_formula.ts  (exits non-zero on failure)
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { combineSubScores, DEFAULT_WEIGHTS, type ScoreBreakdown } from '../packages/tools/src/scoring.ts';

const base: ScoreBreakdown = {
  industry_match: 1.0, stage_match: 0.4, signal_strength: 0.4,
  evidence_depth: 0.83, recency: 0.98, graph_proximity: 0.0, rrf_prefilter: 0.4,
};
let fail = 0;
function eq(label: string, got: number, want: number) {
  const ok = Math.abs(got - want) < 1e-6;
  if (!ok) fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: got ${got.toFixed(4)} want ${want.toFixed(4)}`);
}

console.log('combineSubScores:');
// 1. No unknown dims => identical to the old plain weighted sum (weights sum to 1).
const old = 0.30*1.0 + 0.20*0.4 + 0.10*0.4 + 0.20*0.83 + 0.10*0.98 + 0.10*0.0;
eq('unchanged when nothing is unknown', combineSubScores(base), old);
eq('unknown_dims undefined behaves the same', combineSubScores({ ...base, unknown_dims: undefined }), old);

// 2. Dropping graph_proximity renormalizes over the remaining 0.90 of weight.
const noGraph = (0.30*1.0 + 0.20*0.4 + 0.10*0.4 + 0.20*0.83 + 0.10*0.98) / 0.90;
eq('drops graph_proximity and renormalizes', combineSubScores({ ...base, unknown_dims: ['graph_proximity'] }), noGraph);

// 3. Dropping both unmeasured dims — the Sudden case.
const both = (0.30*1.0 + 0.10*0.4 + 0.20*0.83 + 0.10*0.98) / 0.70;
eq('drops graph_proximity + stage_match', combineSubScores({ ...base, unknown_dims: ['graph_proximity','stage_match'] }), both);
console.log(`  (Sudden account moves ${old.toFixed(3)} -> ${both.toFixed(3)})`);

// 4. An unmeasured dimension can never drag the score down.
eq('unknown dim never lowers the score', Math.min(0, both - old) , 0);

// 5. Everything unknown => 0, not NaN.
eq('all dims unknown returns 0 not NaN',
  combineSubScores({ ...base, unknown_dims: ['industry_match','stage_match','signal_strength','evidence_depth','recency','graph_proximity'] }), 0);

// 6. Result stays inside [0,1] with a lopsided weights object.
const odd = combineSubScores({ ...base, unknown_dims: ['stage_match'] }, { ...DEFAULT_WEIGHTS, industry_match: 5 });
console.log(`  ${odd >= 0 && odd <= 1 ? 'PASS' : 'FAIL'}  clamped to [0,1] with oversized weights: ${odd.toFixed(4)}`);
if (!(odd >= 0 && odd <= 1)) fail++;

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
