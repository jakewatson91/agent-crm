/**
 * Assertions for the Exa request shape buildAngleRequest produces per scope.
 *
 * No test runner in this repo, so this stands in as the regression guard for
 * which filters reach Exa. Two invariants are worth pinning:
 *
 *  - policy.research.exclude_domains reaches the scopes searched BY NAME (news,
 *    open_web) and no others. own_site and social already send an include list
 *    naming every host they will accept, so an exclusion there is dead weight at
 *    best and a rejected request at worst.
 *  - the freshness window never exceeds the ingestion floor, which is what
 *    stopped two of five angles buying results the gate would bin on arrival.
 *
 * Run: tsx scripts/check_research_angles.ts   (exits non-zero on failure)
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { buildAngleRequest } from '../inngest/functions/research.ts';
import { clampQuery, angleRecordBlock, stampRecordSince, carryOffSwitch, failedAngles, orphanedAngles, questionsWorthSearching } from '../packages/tools/src/research_strategy.ts';
import { resolveBrief, PAIN_QUESTION } from '../packages/tools/src/research_brief.ts';
import { resolveTierCadenceHours, DEFAULT_TIER_CADENCE_HOURS } from '../packages/tools/src/policy.ts';
import type { ResearchAngle, WorkspacePolicy } from '../packages/tools/src/policy.ts';

let fail = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
}

const angle = (domain_scope: ResearchAngle['domain_scope'], recency_days?: number): ResearchAngle => ({
  id: String(domain_scope), label: String(domain_scope), query_template: '{entity} streaming',
  domain_scope, recency_days, num_results: 3,
});

const EXCLUDED = ['us.ok.com', 'contentfarm.example'];
const SOCIAL = ['linkedin.com'];
const build = (a: ResearchAngle, exclude: string[] = EXCLUDED) =>
  buildAngleRequest(a, 'FloSports', 'flosports.tv', '', SOCIAL, undefined, 90, exclude)?.params as any;

console.log('exclude_domains reaches the name-searched scopes only:');
eq('news carries the exclusion', build(angle('news', 30)).exclude_domains, EXCLUDED);
eq('open_web carries the exclusion', build(angle('open_web', 30)).exclude_domains, EXCLUDED);
eq('own_site sends no exclusion', build(angle('own_site', 30)).exclude_domains, undefined);
eq('social sends no exclusion', build(angle('social', 30)).exclude_domains, undefined);

console.log('\nan allowlisted scope keeps its include list:');
eq('own_site includes the entity domain', build(angle('own_site', 30)).include_domains, ['flosports.tv']);
eq('social includes the configured hosts', build(angle('social', 30)).include_domains, SOCIAL);
eq('news sends no include list', build(angle('news', 30)).include_domains, undefined);

console.log('\nunset policy sends nothing (runExaSearch drops an empty list):');
eq('open_web exclusion is empty, not undefined', build(angle('open_web', 30), []).exclude_domains, []);
eq('news exclusion is empty, not undefined', build(angle('news', 30), []).exclude_domains, []);

console.log('\nthe query window still respects the ingestion floor:');
const floorDays = (p: any) => p.start_published_date
  ? Math.round((Date.now() - Date.parse(p.start_published_date)) / 86_400_000) : null;
eq('an angle inside the floor keeps its own window', floorDays(build(angle('news', 30))), 30);
eq('an angle wider than the floor is clamped to it', floorDays(build(angle('news', 365))), 90);
eq('an evergreen angle stays unbounded', floorDays(build(angle('open_web'))), null);

console.log('\nscopes that cannot run return null rather than a bad request:');
eq('own_site with no domain', buildAngleRequest(angle('own_site', 30), 'FloSports', '', '', SOCIAL, undefined, 90, EXCLUDED), null);
eq('social with no configured hosts', buildAngleRequest(angle('social', 30), 'FloSports', 'flosports.tv', '', [], undefined, 90, EXCLUDED), null);

// A query template over the length cap used to be hard-sliced, which cut mid-word
// and mid-group: a planner run produced `... (said OR explained OR desc`, an
// unclosed OR-group containing half a word, and it went to Exa exactly like that.
console.log('\na too-long query is cut to something still valid:');
const long = (tail: string) => `{entity} ${'x'.repeat(180)} ${tail}`;
const balanced = (s: string) => (s.match(/\(/g) ?? []).length === (s.match(/\)/g) ?? []).length
  && ((s.match(/"/g) ?? []).length) % 2 === 0;
eq('a short query is untouched', clampQuery('{entity} CDN cost'), '{entity} CDN cost');
eq('the cut never leaves a group open', balanced(clampQuery(long('(said OR explained OR described)'))), true);
eq('the cut never leaves a quote open', balanced(clampQuery(long('"delivery costs"'))), true);
eq('the cut never leaves a half word', /\bx{1,179}$/.test(clampQuery(long('(a OR b)'))) === false, true);
eq('what survives still names the entity', clampQuery(long('(a OR b)')).includes('{entity}'), true);

// The record exists so the planner that writes the QUERIES can act on a bad one.
// The brief planner has had this feedback since the scorecard landed, but it
// writes questions, so "the search is wrong" landed on something that could not
// rewrite a search.
console.log('\nan angle carries its own track record into the next regeneration:');
const block = (fetched: number, kept: number) =>
  angleRecordBlock([angle('social', 30)], [{ id: 'social', fetched, kept }]);
// The per-angle verdict only, not the whole block. Asserting against the block
// let a test pass on its boilerplate: "a keep rate under 10% says rewrite"
// matched the word "rewrite its query" in the closing paragraph, so it held
// whatever the verdict said and could never have failed.
const withRecord = (fetched: number, kept: number) =>
  block(fetched, kept).split('\n').find((l) => l.trim().startsWith('[')) ?? '';
eq('no prior angles means no block at all', angleRecordBlock([], []), '');
eq('an unmeasured angle is left alone', withRecord(0, 0).includes('TOO EARLY TO JUDGE'), true);
eq('a small sample is still too early', withRecord(29, 0).includes('TOO EARLY TO JUDGE'), true);
eq('fetching plenty and keeping none is called out', withRecord(183, 0).includes('CANNOT work as written'), true);
// The bar is one answer per fair trial, so 5 in 100 is a working angle and 1 in
// 264 — the live one — is not. Under the old 10% reading the first was condemned
// and under the old zero test the second was untouchable.
eq('one answer per 30 pages is working, and says so', withRecord(100, 5).includes('earning its place'), true);
eq('one answer in 264 pages is not, and says rewrite', withRecord(264, 1).includes('Rewrite it'), true);
eq('and it quotes the numbers back', withRecord(264, 1).includes('1 time(s) in 264 pages'), true);
eq('a working angle is told to stay put', withRecord(100, 40).includes('earning its place'), true);
eq('a bad record never reads as a bad question', block(183, 0).includes('not a bad question'), true);

// The id is kept across a rewrite so the record survives, which is exactly why a
// rewritten query must not inherit it: the LinkedIn angle became a news angle
// under the same id, and its 183-fetched-0-kept history is about a search that no
// longer exists.
console.log('\na rewritten search starts its record over, an unchanged one does not:');
const NOW = '2026-08-10T12:00:00.000Z';
const OLD = '2026-07-01T00:00:00.000Z';
const prior: ResearchAngle[] = [
  { ...angle('social', 30), id: 'leader', query_template: '{entity} CDN talk', record_since: OLD },
  { ...angle('news', 30), id: 'launches', query_template: '{entity} launched', record_since: OLD },
];
// A freshly planned angle never carries record_since — coerceAngle does not set
// it — so every `next` below is shaped the way the planner returns them.
const planned = (a: ResearchAngle): ResearchAngle => { const { record_since: _drop, ...rest } = a; return rest; };
const stamped = (next: ResearchAngle[]) => stampRecordSince(next.map(planned), prior, NOW);
eq('an untouched angle keeps its start date',
  stamped([prior[1]!])[0]!.record_since, OLD);
eq('a rewritten query starts over',
  stamped([{ ...prior[0]!, query_template: '{entity} CTO interview' }])[0]!.record_since, NOW);
eq('the same query moved to another scope starts over',
  stamped([{ ...prior[0]!, domain_scope: 'news' }])[0]!.record_since, NOW);
eq('a brand-new angle starts now',
  stamped([{ ...angle('open_web', 30), id: 'fresh' }])[0]!.record_since, NOW);
// An angle written before this field existed has a real record already. Leaving
// it unset means "count everything", which is what that record is.
eq('an unchanged angle predating the field keeps counting everything',
  stampRecordSince([planned(prior[1]!)], [planned(prior[1]!)], NOW)[0]!.record_since, undefined);

// coerceAngle sets enabled:true on everything it returns and the persist replaces
// the whole array, so before this a human's off switch came back on within 14
// days, in every workspace, with nothing in any log to say why.
console.log('\na human off switch survives a regeneration:');
const off: ResearchAngle[] = [{ ...angle('news', 30), id: 'a', enabled: false }, { ...angle('news', 30), id: 'b' }];
const replanned: ResearchAngle[] = [
  { ...angle('news', 30), id: 'a', query_template: '{entity} rewritten', enabled: true },
  { ...angle('news', 30), id: 'b', enabled: true },
  { ...angle('open_web', 30), id: 'c', enabled: true },
];
eq('an angle switched off stays off', carryOffSwitch(replanned, off)[0]!.enabled, false);
eq('rewriting its query does not switch it back on',
  carryOffSwitch(replanned, off)[0]!.query_template, '{entity} rewritten');
eq('an angle left alone stays on', carryOffSwitch(replanned, off)[1]!.enabled, true);
eq('a brand-new angle is on', carryOffSwitch(replanned, off)[2]!.enabled, true);
eq('nothing switched off changes nothing', carryOffSwitch(replanned, []), replanned);

// Age was the only staleness test, so a search provably buying nothing kept
// running for up to 14 days. The bar is now the same one the whole loop uses: a
// search must answer the question it was bought for at least once per fair trial.
console.log('\nan angle that is not earning its searches forces a rewrite; an unproven one does not:');
const rec = (id: string, fetched: number, kept: number) => ({ id, fetched, kept });
const one = [{ ...angle('news', 30), id: 'a' }];
eq('a fair trial with zero keeps has failed', failedAngles(one, [rec('a', 183, 0)]), ['a']);
eq('a small sample has not', failedAngles(one, [rec('a', 29, 0)]), []);
// Under the old zero test, one accidental page bought an angle permanent
// immunity: the live one sat at 1 answer in 264 pages and was never rewritten.
eq('one lucky page in 183 does not save it', failedAngles(one, [rec('a', 183, 1)]), ['a']);
eq('a thin but real keep rate is left alone', failedAngles(one, [rec('a', 100, 5)]), []);
eq('exactly one answer per fair trial is enough', failedAngles(one, [rec('a', 30, 1)]), []);
eq('an angle with no record at all has not failed', failedAngles(one, []), []);
eq('an angle a human switched off is not counted',
  failedAngles([{ ...one[0]!, enabled: false }], [rec('a', 183, 0)]), []);

// `answers` is checked against the brief that existed at plan time. The brief is
// regenerated on its own schedule, so a question can be reworded out from under a
// running angle, which then keeps buying pages for something nothing asks about.
console.log('\nan angle pointed at a question that no longer exists is spotted:');
const withBrief = (strategy: ResearchAngle[], ids: string[]) => ({
  research: { strategy, brief: ids.map((id) => ({ id, label: id, question: `q ${id}`, why: '', kind: 'state' as const, enabled: true })) },
});
const served = (answers: string | undefined, enabled = true) => [{ ...angle('news', 30), id: 'a', answers, enabled }];
eq('an angle whose question is live is fine', orphanedAngles(withBrief(served('recent_launch'), ['recent_launch'])), []);
eq('an angle whose question is gone is orphaned', orphanedAngles(withBrief(served('retired_q'), ['recent_launch'])), ['a']);
eq('an angle with no question at all is not an orphan', orphanedAngles(withBrief(served(undefined), ['recent_launch'])), []);
eq('a switched-off orphan does not force anything', orphanedAngles(withBrief(served('retired_q', false), ['recent_launch'])), []);
eq('the always-on pain question counts as live', orphanedAngles(withBrief(served('pain'), ['recent_launch'])), []);

// Withholding a question from the planner is the whole enforcement — there is no
// "do not search for this" switch anywhere, only a question the planner is never
// shown. So this is where research money is decided.
console.log('\nthe planner is shown only the questions worth pointing a search at:');
{
  const q = (id: string) => ({ id, label: id, question: `q ${id}`, why: '', kind: 'state' as const, enabled: true });
  const pol = { research: { brief: [q('recent_launch'), q('technical_leader')] } } as WorkspacePolicy;
  const r = (id: string, fetched: number, kept: number) => ({ id, fetched, kept });

  eq('with nothing measured, every question is fair game',
    questionsWorthSearching(pol, []).map((x) => x.id), ['recent_launch', 'technical_leader']);
  eq('pain is never searched for even though it is in the brief',
    questionsWorthSearching(pol, []).some((x) => x.id === PAIN_QUESTION.id), false);
  eq('a question no search answers is withheld',
    questionsWorthSearching(pol, [r('technical_leader', 264, 1)]).map((x) => x.id), ['recent_launch']);
  eq('and the working one is still shown',
    questionsWorthSearching(pol, [r('technical_leader', 264, 1), r('recent_launch', 199, 84)]).map((x) => x.id), ['recent_launch']);
  // Withheld from the SEARCH planner only. The gate and the extractor read the
  // brief, and that is how a question like pain gets answered at all.
  eq('but it stays in the brief the gate reads',
    resolveBrief(pol).map((x) => x.id), ['recent_launch', 'technical_leader', PAIN_QUESTION.id]);
  // The record window rolls, so a dead question's spend ages off and it gets
  // tried again — roughly one probe a month rather than a permanent verdict.
  eq('once its old spend ages out of the window it is tried again',
    questionsWorthSearching(pol, [r('technical_leader', 0, 0)]).map((x) => x.id), ['recent_launch', 'technical_leader']);
}

// Hot cadence was a hardcoded 24h until 2026-08-10. Measured on a 2,243-account
// book, yield per search held through ~7 passes a month then fell off a cliff
// (0.33 on the 8th, 0.22 from the 10th), so roughly a third of the search budget
// was being spent past the point it stopped paying. 96h lands at ~7 passes.
console.log('\ntier cadence is config, with a default that keeps the budget off the cliff:');
const cad = (research?: unknown) => resolveTierCadenceHours({ research } as WorkspacePolicy);
eq('unset falls back to the defaults', cad(), { ...DEFAULT_TIER_CADENCE_HOURS });
eq('the hot default is 96h, not 24h', DEFAULT_TIER_CADENCE_HOURS.hot, 96);
eq('a workspace can override one tier', cad({ tier_cadence_hours: { hot: 24 } }).hot, 24);
eq('overriding one tier leaves the others alone', cad({ tier_cadence_hours: { hot: 24 } }).cold, DEFAULT_TIER_CADENCE_HOURS.cold);
eq('zero is not a cadence', cad({ tier_cadence_hours: { hot: 0 } }).hot, DEFAULT_TIER_CADENCE_HOURS.hot);
eq('negative is not a cadence', cad({ tier_cadence_hours: { hot: -5 } }).hot, DEFAULT_TIER_CADENCE_HOURS.hot);
eq('a string is not a cadence', cad({ tier_cadence_hours: { hot: '48' } }).hot, DEFAULT_TIER_CADENCE_HOURS.hot);
eq('NaN is not a cadence', cad({ tier_cadence_hours: { hot: Number.NaN } }).hot, DEFAULT_TIER_CADENCE_HOURS.hot);

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
