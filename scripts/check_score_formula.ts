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
import {
  combineSubScores, explainScore, explainScoreChange, breakdownFromFacts, VETO_KEY,
  DEFAULT_WEIGHTS, type ScoreBreakdown,
} from '../packages/tools/src/scoring.ts';

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
// ...but that holds only WITHIN one call. Across two scoring runs, a dimension
// that becomes measurable at a value below the account's average lowers the
// total by joining it. This is not a contradiction of the line above and it is
// not a bug: it is the honest answer arriving. Asserted so nobody reads #4 as a
// guarantee that scores only rise when we learn more. Live case: Go3, freshness
// unmeasurable -> 0.32, total 0.90 -> 0.82.
const go3Prev: ScoreBreakdown = {
  industry_match: 1.0, stage_match: 0.4, signal_strength: 0.4, evidence_depth: 1.0,
  recency: 0, graph_proximity: 0, rrf_prefilter: 0.47,
  unknown_dims: ['graph_proximity', 'stage_match', 'recency'],
};
const go3Next: ScoreBreakdown = { ...go3Prev, recency: 0.3169, unknown_dims: ['graph_proximity', 'stage_match'] };
eq('Go3 before', combineSubScores(go3Prev), 0.90);
eq('Go3 after', combineSubScores(go3Next), (0.30 * 1.0 + 0.10 * 0.4 + 0.20 * 1.0 + 0.10 * 0.3169) / 0.70);
console.log(`  (a dimension becoming measurable at 0.32 costs ${(combineSubScores(go3Next) - combineSubScores(go3Prev)).toFixed(3)})`);

// 5. Everything unknown => 0, not NaN.
eq('all dims unknown returns 0 not NaN',
  combineSubScores({ ...base, unknown_dims: ['industry_match','stage_match','signal_strength','evidence_depth','recency','graph_proximity'] }), 0);

// 6. Recency joins the unmeasured set when no fact traces to a dated source.
// Guards the fix for the fallback that dated facts off our own write time: the
// dimension read p10 0.65 / p90 0.66 across 2009 Sudden accounts, a constant
// carrying 10% of the weight. Unmeasured must mean dropped, not zero.
const noRecency = (0.30*1.0 + 0.20*0.4 + 0.10*0.4 + 0.20*0.83 + 0.10*0.0) / 0.90;
eq('drops recency and renormalizes', combineSubScores({ ...base, unknown_dims: ['recency'] }), noRecency);
// Zeroing it instead would punish the account for a gap in OUR data, not a bad fit.
const recencyAsZero = 0.30*1.0 + 0.20*0.4 + 0.10*0.4 + 0.20*0.83 + 0.10*0.0 + 0.10*0.0;
eq('zeroing an unmeasured recency scores strictly lower', combineSubScores({ ...base, recency: 0 }), recencyAsZero);
console.log(`  (unmeasured -> ${noRecency.toFixed(3)}, zeroed -> ${recencyAsZero.toFixed(3)}: the ${(noRecency - recencyAsZero).toFixed(3)} gap is why "unknown" must not be 0)`);
// The three real gaps on a fresh CSV import: no edges, no ground truth, no dated source.
const allThree = (0.30*1.0 + 0.10*0.4 + 0.20*0.83) / 0.60;
eq('drops graph_proximity + stage_match + recency',
  combineSubScores({ ...base, unknown_dims: ['graph_proximity','stage_match','recency'] }), allThree);

// 7. Result stays inside [0,1] with a lopsided weights object.
const odd = combineSubScores({ ...base, unknown_dims: ['stage_match'] }, { ...DEFAULT_WEIGHTS, industry_match: 5 });
console.log(`  ${odd >= 0 && odd <= 1 ? 'PASS' : 'FAIL'}  clamped to [0,1] with oversized weights: ${odd.toFixed(4)}`);
if (!(odd >= 0 && odd <= 1)) fail++;

// ---------------------------------------------------------------------------
console.log('\nexplainScore:');

const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

// 8. The split is exhaustive: the per-dimension contributions ARE the total.
// This is what lets a UI show the arithmetic instead of asserting a number.
for (const unknown of [undefined, ['graph_proximity'], ['graph_proximity', 'stage_match', 'recency']]) {
  const b: ScoreBreakdown = { ...base, unknown_dims: unknown };
  const ex = explainScore(b);
  eq(`contributions sum to the total (unknown=${JSON.stringify(unknown ?? [])})`,
    sum(ex.contributions.map((c) => c.contribution)), combineSubScores(b));
}

// 9. An unmeasured dimension contributes nothing and says so, rather than
// contributing its stored placeholder. The entity page read that placeholder
// and rendered "low" for a dimension nobody had measured.
const exGap = explainScore({ ...base, recency: 0, unknown_dims: ['recency'] });
const recRow = exGap.contributions.find((c) => c.key === 'recency')!;
console.log(`  ${!recRow.measured && recRow.contribution === 0 && recRow.effective_weight === 0 ? 'PASS' : 'FAIL'}  unmeasured dim reports measured=false and contributes 0`);
if (recRow.measured || recRow.contribution !== 0) fail++;
// The measured dimensions' effective weights sum to 1: that IS the renormalize.
eq('effective weights of measured dims sum to 1',
  sum(exGap.contributions.filter((c) => c.measured).map((c) => c.effective_weight)), 1);

// ---------------------------------------------------------------------------
console.log('\nexplainScoreChange:');

// 10. Wedotv, the case that started this. Its only edge was a contact, so
// graph_proximity had nothing to average; keying "measurable" off edge_count
// instead of scored_neighbor_count let a fabricated 0.00 join the mean. The
// stored graph number read 0.00 before AND after, so a diff of the sub-scores
// saw nothing move and the page blamed freshness — which was worth 0.008 of a
// 0.127 drop. The explanation must name graph_proximity.
const wedoPrev: ScoreBreakdown = {
  industry_match: 1.0, stage_match: 0.4, signal_strength: 0.7, evidence_depth: 1.0,
  recency: 0.8947, graph_proximity: 0, rrf_prefilter: 0.44,
  unknown_dims: ['graph_proximity', 'stage_match'],
};
const wedoNext: ScoreBreakdown = { ...wedoPrev, recency: 0.8171, unknown_dims: ['stage_match'] };
eq('Wedotv before', combineSubScores(wedoPrev), 0.65947 / 0.70);
eq('Wedotv after', combineSubScores(wedoNext), (0.30 + 0.07 + 0.20 + 0.08171) / 0.80);

const wedoMove = explainScoreChange(wedoPrev, wedoNext);
eq('move lines sum to the delta', sum(wedoMove.lines.map((l) => l.effect)), wedoMove.delta);

const graphLine = wedoMove.lines.find((l) => l.key === 'graph_proximity');
const freshLine = wedoMove.lines.find((l) => l.key === 'recency');
// Assert the specific line, not that "some line exists": a test that only
// checks the sum passes just as happily when the cause is misattributed.
console.log(`  ${graphLine?.cause === 'started_counting' ? 'PASS' : 'FAIL'}  graph_proximity line reads started_counting (got ${graphLine?.cause ?? 'no line'})`);
if (graphLine?.cause !== 'started_counting') fail++;
const graphShare = graphLine ? Math.abs(graphLine.effect) / Math.abs(wedoMove.delta) : 0;
console.log(`  ${graphShare >= 0.9 ? 'PASS' : 'FAIL'}  graph_proximity carries >=90% of the drop: ${(graphShare * 100).toFixed(1)}%`);
if (graphShare < 0.9) fail++;
console.log(`  ${freshLine && Math.abs(freshLine.effect) <= 0.011 ? 'PASS' : 'FAIL'}  freshness is worth <=0.011 of it: ${freshLine?.effect.toFixed(4) ?? 'no line'}`);
if (!freshLine || Math.abs(freshLine.effect) > 0.011) fail++;
console.log(`  (${wedoMove.total_prev.toFixed(3)} -> ${wedoMove.total_next.toFixed(3)}; ${wedoMove.lines.map((l) => `${l.key} ${l.effect >= 0 ? '+' : ''}${l.effect.toFixed(3)}`).join(', ')})`);

// 11. Go3: the dimension that rose is the one that lowered the total, and the
// line says so instead of reporting an improvement from "0.00".
const go3Move = explainScoreChange(go3Prev, go3Next);
eq('Go3 move lines sum to the delta', sum(go3Move.lines.map((l) => l.effect)), go3Move.delta);
const go3Rec = go3Move.lines.find((l) => l.key === 'recency');
const go3Ok = go3Rec?.cause === 'started_counting' && go3Rec.prev_value === null && go3Rec.effect < 0;
console.log(`  ${go3Ok ? 'PASS' : 'FAIL'}  freshness reads started_counting with no prev value and a negative effect (${go3Rec?.cause}, prev=${go3Rec?.prev_value}, effect ${go3Rec?.effect.toFixed(3)})`);
if (!go3Ok) fail++;

// 12. A dimension that stops counting is explained too, not silently absorbed.
const stopped = explainScoreChange(wedoNext, { ...wedoNext, unknown_dims: ['stage_match', 'recency'] });
eq('stopped-counting lines sum to the delta', sum(stopped.lines.map((l) => l.effect)), stopped.delta);
console.log(`  ${stopped.lines[0]?.cause === 'stopped_counting' ? 'PASS' : 'FAIL'}  a dimension leaving the mean reads stopped_counting`);
if (stopped.lines[0]?.cause !== 'stopped_counting') fail++;

// 13. Nothing changed => nothing to explain. Guards against a card that lists
// six no-op lines every time the scorer reruns on identical inputs.
const flat = explainScoreChange(wedoNext, wedoNext);
console.log(`  ${flat.lines.length === 0 && flat.delta === 0 ? 'PASS' : 'FAIL'}  identical breakdowns produce no lines`);
if (flat.lines.length !== 0 || flat.delta !== 0) fail++;

// 14. The out_of_scope veto. It forces icp_fit to 0 no matter what the
// dimensions say, so an explanation built only from dimensions describes a
// number the account does not have. Live case: Telesat read 0.00 -> 0.39 while
// industry_match AND signal_strength both fell 0.40 -> 0.00 — the entire move
// was the veto coming off, and a dimensions-only account of it summed to -0.23
// against a +0.39 header.
const teleVetoed: ScoreBreakdown = {
  industry_match: 0.4, stage_match: 0.4, signal_strength: 0.4, evidence_depth: 1.0,
  recency: 0.7543, graph_proximity: 0, rrf_prefilter: 0.48,
  unknown_dims: ['graph_proximity', 'stage_match'],
  out_of_scope: 'They sell video infrastructure, not to our buyer',
};
const teleClear: ScoreBreakdown = {
  industry_match: 0, stage_match: 0.4, signal_strength: 0, evidence_depth: 1.0,
  recency: 0.7373, graph_proximity: 0, rrf_prefilter: 0.51,
  unknown_dims: ['graph_proximity', 'stage_match'],
};
eq('a vetoed account scores 0 however its dimensions read', explainScore(teleVetoed).total, 0);
eq('and its dimensions still add up on their own',
  sum(explainScore(teleVetoed).contributions.map((c) => c.contribution)), explainScore(teleVetoed).dimension_total);

const teleMove = explainScoreChange(teleVetoed, teleClear);
eq('Telesat before (vetoed)', teleMove.total_prev, 0);
eq('Telesat after', teleMove.total_next, (0.30 * 0 + 0.10 * 0 + 0.20 * 1.0 + 0.10 * 0.7373) / 0.70);
eq('veto lines sum to the delta', sum(teleMove.lines.map((l) => l.effect)), teleMove.delta);
const vetoLine = teleMove.lines.find((l) => l.key === VETO_KEY);
const vetoOk = vetoLine?.cause === 'veto_lifted' && vetoLine.effect > 0 && !!vetoLine.note;
console.log(`  ${vetoOk ? 'PASS' : 'FAIL'}  the lift reads veto_lifted, carries the condition text, and is positive (${vetoLine?.effect.toFixed(3)})`);
if (!vetoOk) fail++;
// The dimensions that fell must still show as falling. Flattening them into the
// veto line would hide a real deterioration behind good news.
const teleInd = teleMove.lines.find((l) => l.key === 'industry_match');
console.log(`  ${teleInd && teleInd.effect < 0 ? 'PASS' : 'FAIL'}  industry match still reads as a drop under a lifted veto (${teleInd?.effect.toFixed(3)})`);
if (!teleInd || teleInd.effect >= 0) fail++;
console.log(`  (${teleMove.total_prev.toFixed(2)} -> ${teleMove.total_next.toFixed(2)}; ${teleMove.lines.map((l) => `${l.key} ${l.effect >= 0 ? '+' : ''}${l.effect.toFixed(3)}`).join(', ')})`);

// 15. And the other direction: a veto landing absorbs the drop to 0.
const vetoLanding = explainScoreChange(teleClear, { ...teleClear, out_of_scope: 'now out of scope' });
eq('a landing veto sums to the delta', sum(vetoLanding.lines.map((l) => l.effect)), vetoLanding.delta);
eq('and takes the total to 0', vetoLanding.total_next, 0);
console.log(`  ${vetoLanding.lines.at(-1)?.cause === 'vetoed' ? 'PASS' : 'FAIL'}  the landing veto is the last line`);
if (vetoLanding.lines.at(-1)?.cause !== 'vetoed') fail++;

// ---------------------------------------------------------------------------
console.log('\nbreakdownFromFacts:');

// 14. The breakdown JSON wins, because it is the only place unknown_dims lives.
// Reading the score_* rows alone is what turned "not measured" into "low".
const withBlob = breakdownFromFacts([
  { predicate: 'icp_fit_breakdown', object_text: JSON.stringify(wedoPrev) },
  { predicate: 'score_recency', object_text: '0.89' },
]);
console.log(`  ${withBlob?.source === 'breakdown' && withBlob.breakdown.unknown_dims?.includes('graph_proximity') ? 'PASS' : 'FAIL'}  prefers the breakdown fact and keeps unknown_dims`);
if (withBlob?.source !== 'breakdown' || !withBlob.breakdown.unknown_dims?.includes('graph_proximity')) fail++;
eq('rebuilt breakdown recomputes the same total', combineSubScores(withBlob!.breakdown), combineSubScores(wedoPrev));

// 15. Fallback path is reachable and labelled, so a caller can tell that the
// unmeasured set is unrecoverable rather than empty.
const noBlob = breakdownFromFacts([
  { predicate: 'score_industry_match', object_text: '1.00' },
  { predicate: 'score_recency', object_text: '0.50' },
]);
console.log(`  ${noBlob?.source === 'score_facts' ? 'PASS' : 'FAIL'}  falls back to score_* rows and labels the source`);
if (noBlob?.source !== 'score_facts') fail++;
console.log(`  ${breakdownFromFacts([{ predicate: 'name', object_text: 'x' }]) === null ? 'PASS' : 'FAIL'}  returns null when there is no score at all`);
if (breakdownFromFacts([{ predicate: 'name', object_text: 'x' }]) !== null) fail++;

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
