/**
 * Assertions for how the age of a SOURCE reaches the things that judge a fact.
 *
 * The rule the whole system runs on, stated once: age kills events, not state.
 * A dated event goes stale and stops being something you can open a message
 * with. A fact about how the company stands does not expire because the page
 * reporting it is old, and a fact with no date at all was never an event.
 *
 * The drafter's craft rules enforce that directly (an undated fact can never be
 * the trigger; a dated event past trigger_max_age_days is dead weight). What
 * these assertions cover is the plumbing underneath, which used to measure when
 * WE touched something instead of when the source was published:
 *
 *   1. score_facts ranked on facts.observed_at, stamped now() by assert_fact.
 *      Every fact was born with recency = exp(-0/tau) = 1, so a claim pulled out
 *      of a 2013 forum post outranked nothing and was outranked by nothing.
 *      Aging undated facts on observed_at instead is the opposite error: it
 *      decays a CSV attribute for having been imported a while ago.
 *   2. A research signal's magnitude was computed once, at creation, from the
 *      search provider's date. When the enricher later read the real dateline
 *      off the page, the magnitude kept its original value.
 *
 * No test runner in this repo, so this stands in as the regression guard.
 *
 * Run: tsx scripts/check_source_age.ts   (exits non-zero on failure)
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import {
  ageDecay, researchSignalMagnitude, RESEARCH_SIGNAL_BASE_MAGNITUDE, HOOK_CLASS_WEIGHT,
  DEFAULT_MAX_AGE_DAYS, DEFAULT_CONTACT_MAX_AGE_DAYS, DEFAULT_DECAY_HALF_LIFE_DAYS,
} from '../packages/tools/src/scoring.ts';
import { DEFAULT_CONFIG } from '../packages/tools/src/score_facts.ts';

let fail = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
}
function ok(label: string, cond: boolean) {
  if (!cond) fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();

/**
 * The recency term exactly as score_facts computes it. Duplicated here rather
 * than exported because the scorer's own function needs a Supabase client and
 * embeddings; this is the one line of it that the date correction changes.
 */
function recency(source_date: string | null): number {
  const sourceMs = source_date ? Date.parse(source_date) : NaN;
  const age_days = Number.isFinite(sourceMs) ? Math.max(0, (Date.now() - sourceMs) / 86400_000) : 0;
  return Math.exp(-age_days / DEFAULT_CONFIG.tau_recency_days);
}

console.log('fact recency is aged from the source, not from when we extracted it:');
// The case that motivated this: both facts were written to the book today.
const freshFact = recency(daysAgo(2));
const staleFact = recency(daysAgo(1200));
ok('a fact from a 2-day-old article scores near 1', freshFact > 0.95);
ok('a fact extracted today from a 1200-day-old article does not', staleFact < 0.01);
ok('the fresh one outranks the stale one', freshFact > staleFact * 50);

console.log('\nan undated fact is timeless, not ancient and not brand new:');
// 90% of active facts have no signal at all (CSV attributes, derived data).
// "They are a broadcaster" does not get less true while it sits in the book,
// so the import date must not decide whether it clears min_score.
eq('no source date scores a flat 1', Math.round(recency(null) * 1000) / 1000, 1);
eq('an unparseable source date is treated the same, not thrown on',
  Math.round(recency('not a date') * 1000) / 1000, 1);
ok('an undated fact ties with a same-day dated one rather than losing to it',
  recency(null) >= recency(daysAgo(0)));
ok('but a fresh EVENT still beats an old dated one, which is what ranking is for',
  recency(daysAgo(2)) > recency(daysAgo(200)) * 10);
ok('a source dated in the future is clamped to age 0, never boosted above 1',
  recency(daysAgo(-30)) === 1);

console.log('\nmagnitude tracks the corrected date, not the one the provider guessed:');
const halfLife = DEFAULT_DECAY_HALF_LIFE_DAYS;
const asProviderSaid = researchSignalMagnitude(daysAgo(3), halfLife, 'event');
const asPageActuallyReads = researchSignalMagnitude(daysAgo(2200), halfLife, 'event');
ok('a genuinely fresh event keeps ~base magnitude', asProviderSaid > 0.55);
ok('the same signal recomputed against a 2020 dateline collapses', asPageActuallyReads < 0.1);
ok('recomputing actually changes the number', asProviderSaid > asPageActuallyReads * 5);
eq('hook class still scales it: profile is half of event',
  researchSignalMagnitude(null, halfLife, 'profile'),
  Number((RESEARCH_SIGNAL_BASE_MAGNITUDE * HOOK_CLASS_WEIGHT.profile).toFixed(3)));
eq('an unclassified signal is not penalised',
  researchSignalMagnitude(null, halfLife, undefined),
  Number(RESEARCH_SIGNAL_BASE_MAGNITUDE.toFixed(3)));
eq('an undated source is not decayed (evergreen pages)',
  researchSignalMagnitude(null, halfLife, 'event'), asProviderSaid > 0 ? Number((RESEARCH_SIGNAL_BASE_MAGNITUDE * 1 * 1).toFixed(3)) : 0);
ok('ageDecay never returns exactly 0, so a slipped-through source keeps a trace',
  ageDecay(daysAgo(50_000), halfLife) === 0.05);

console.log('\nfreshness gating lives in the drafter, not in this term:');
// Deliberately NOT enforced here. An earlier version of this work had the
// enricher drop every fact off a page whose corrected dateline was past the
// floor, which deleted exactly the state facts the craft rules keep ("a case
// study from two years ago saying they adopted a particular encoder is still
// true about their stack today"). The floor belongs at search time, where it
// stops us paying for the page, and in the drafter, where it decides what may
// open a message. Nothing in between should be deleting evidence.
ok('the two floors that matter are exposed for the search-time gate to use',
  DEFAULT_MAX_AGE_DAYS > 0 && DEFAULT_CONTACT_MAX_AGE_DAYS > 0);
ok('contacts get the wider one: people post less often than companies publish',
  DEFAULT_CONTACT_MAX_AGE_DAYS > DEFAULT_MAX_AGE_DAYS);
ok('an old dated fact still ranks below a fresh one without being excluded',
  recency(daysAgo(400)) > 0 && recency(daysAgo(400)) < recency(daysAgo(5)));

console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);
