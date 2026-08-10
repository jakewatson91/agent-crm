/**
 * Assertions for the research brief and for "which version of a fact is current".
 *
 * No test runner in this repo, so this stands in as the regression guard for two
 * things that have each broken in production.
 *
 * 1. currentFactRows — reading a supersede chain backwards. A rescore writes the
 *    NEW row carrying supersedes=<old id>, so the row whose own `supersedes` is
 *    null is the FIRST-EVER value and never moves again. Filtering on it returns
 *    the oldest score, not the newest. That shipped three separate times: the
 *    agent's book projection, the stale-rescore scan, and the research
 *    dispatcher, where it tiered 89% of accounts on a stale number and sent 57
 *    dead accounts to daily research while visiting genuinely hot ones monthly.
 *    It kept coming back because every caller re-derived it by hand.
 *
 * 2. resolveBrief — the questions every research stage shares. A workspace that
 *    has configured nothing must still get a working, vertical-neutral set, and
 *    the pain question must be impossible to switch off: a page reporting that a
 *    company's service buckled under load answers no other question, and it is
 *    the most valuable page there is.
 *
 * Run: tsx scripts/check_research_brief.ts   (exits non-zero on failure)
 */
import { currentFactRows } from '../packages/tools/src/reads.ts';
import { resolveBrief, BASELINE_BRIEF, PAIN_QUESTION, sysPrompt, briefInputHash } from '../packages/tools/src/research_brief.ts';
import type { WorkspacePolicy } from '../packages/tools/src/policy.ts';

let fail = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
}

const row = (id: string, supersedes: string | null, observed_at: string, value: string) =>
  ({ id, supersedes, observed_at, value, key: 'k' });

console.log('\nA supersede chain reads newest-first, not oldest-first:');
{
  // b supersedes a, c supersedes b. Only c is current.
  const rows = [
    row('a', null, '2026-01-01T00:00:00Z', 'first'),
    row('b', 'a', '2026-02-01T00:00:00Z', 'second'),
    row('c', 'b', '2026-03-01T00:00:00Z', 'third'),
  ];
  const cur = currentFactRows(rows, (r) => r.key);
  eq('the newest value wins, not the one with a null supersedes', cur.get('k')?.value, 'third');
  eq('exactly one row survives per key', cur.size, 1);
}

console.log('\nA single unsuperseded row is itself current:');
{
  const rows = [row('a', null, '2026-01-01T00:00:00Z', 'only')];
  eq('one row in, that row out', currentFactRows(rows, (r) => r.key).get('k')?.value, 'only');
}

console.log('\nRows are separated by key, and chains do not leak across them:');
{
  const rows = [
    { id: 'a1', supersedes: null, observed_at: '2026-01-01T00:00:00Z', value: 'old-x', key: 'x' },
    { id: 'a2', supersedes: 'a1', observed_at: '2026-02-01T00:00:00Z', value: 'new-x', key: 'x' },
    { id: 'b1', supersedes: null, observed_at: '2026-01-01T00:00:00Z', value: 'only-y', key: 'y' },
  ];
  const cur = currentFactRows(rows, (r) => r.key);
  eq('x resolves to its newest', cur.get('x')?.value, 'new-x');
  eq('y is untouched by x\'s chain', cur.get('y')?.value, 'only-y');
}

console.log('\nWhen nothing supersedes anything, newest observed_at breaks the tie:');
{
  const rows = [
    row('a', null, '2026-01-01T00:00:00Z', 'older'),
    row('b', null, '2026-05-01T00:00:00Z', 'newer'),
  ];
  eq('newest wins', currentFactRows(rows, (r) => r.key).get('k')?.value, 'newer');
}

console.log('\nAn incomplete read cannot be silently trusted (documents the paging requirement):');
{
  // Caller paged badly and only handed over the older half of the chain. The
  // helper can only work with what it is given: it returns the newest row IT
  // SAW. This is why the dispatcher pages its score read instead of relying on
  // PostgREST's 1000-row default.
  const rows = [row('a', null, '2026-01-01T00:00:00Z', 'first')];
  eq('returns the newest of what it was given', currentFactRows(rows, (r) => r.key).get('k')?.value, 'first');
}

console.log('\nA workspace that configured nothing still gets a working brief:');
{
  const brief = resolveBrief({} as WorkspacePolicy);
  eq('falls back to the neutral baseline', brief.some((q) => q.id === BASELINE_BRIEF[0]!.id), true);
  eq('names no industry, metric or product category', /stream|video|cdn|saas|restaurant|freight/i.test(JSON.stringify(BASELINE_BRIEF)), false);
}

console.log('\nThe pain question can never be configured away:');
{
  eq('present on an empty policy', resolveBrief({} as WorkspacePolicy).some((q) => q.id === PAIN_QUESTION.id), true);
  const custom = { research: { brief: [{ id: 'only_thing', label: 'x', question: 'What do they sell?' }] } } as WorkspacePolicy;
  eq('appended to a fully custom brief', resolveBrief(custom).some((q) => q.id === PAIN_QUESTION.id), true);
  const already = { research: { brief: [{ id: PAIN_QUESTION.id, label: 'x', question: 'What hurts?' }] } } as WorkspacePolicy;
  eq('not duplicated when the brief already defines it', resolveBrief(already).filter((q) => q.id === PAIN_QUESTION.id).length, 1);
}

console.log('\nMalformed or disabled questions are dropped rather than trusted:');
{
  const p = { research: { brief: [
    { id: 'good', label: 'g', question: 'What did they ship recently?' },
    { id: 'off', label: 'o', question: 'Ignored.', enabled: false },
    { id: '', label: 'n', question: 'No id.' },
    { id: 'blank', label: 'b', question: '   ' },
  ] } } as WorkspacePolicy;
  const ids = resolveBrief(p).map((q) => q.id);
  eq('keeps the valid one', ids.includes('good'), true);
  eq('drops the disabled one', ids.includes('off'), false);
  eq('drops the one with no id', ids.includes(''), false);
  eq('drops the one with an empty question', ids.includes('blank'), false);
  eq('and still carries pain', ids.includes(PAIN_QUESTION.id), true);
}

// The brief planner asked what a technical leader had said "in the past year"
// while the workspace bins anything older than 90 days on arrival. The only pages
// that could answer it were thrown away before the gate saw them, so the search
// built for it read as broken across 183 pages when the question was never
// reachable. The strategy planner has been told the floor for a while; the planner
// that writes the questions the angles come from was not.
console.log('\nthe brief planner is told the floor it has to write inside:');
eq('the workspace floor reaches the prompt', sysPrompt(90).includes('more than 90 days ago'), true);
eq('a different floor changes the prompt', sysPrompt(30).includes('more than 30 days ago'), true);
eq('an unset floor still states a number', /more than \d+ days ago/.test(sysPrompt()), true);
eq('the rule names the windows it is banning', sysPrompt(90).includes('in the past year'), true);

// The floor shapes the questions, so moving it must re-open the brief. Without
// this, narrowing the floor leaves every question asking for a window the
// pipeline no longer reaches.
console.log('\nmoving the floor re-opens the brief:');
const baseCtx = { about: 'a', icp: '{}', value_props: [], pain_points: [], guidance: '', always_include: [] };
eq('same inputs hash the same', briefInputHash({ ...baseCtx, max_age_days: 90 }), briefInputHash({ ...baseCtx, max_age_days: 90 }));
eq('a moved floor hashes differently',
  briefInputHash({ ...baseCtx, max_age_days: 30 }) === briefInputHash({ ...baseCtx, max_age_days: 90 }), false);
eq('an unset floor is not the same as a set one',
  briefInputHash({ ...baseCtx }) === briefInputHash({ ...baseCtx, max_age_days: 90 }), false);

console.log(fail === 0 ? '\nALL PASS\n' : `\n${fail} FAILED\n`);
process.exit(fail === 0 ? 0 : 1);
