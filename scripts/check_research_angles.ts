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
import type { ResearchAngle } from '../packages/tools/src/policy.ts';

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

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
