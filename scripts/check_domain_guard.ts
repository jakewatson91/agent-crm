/**
 * Assertions for the domain resolver's guard helpers.
 *
 * No test runner in this repo, so this stands in as the regression guard for
 * the string logic that decides whether an account gets a usable domain — and
 * therefore whether it can ever produce a contact or a draft.
 *
 * Run: tsx scripts/check_domain_guard.ts   (exits non-zero on failure)
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { registrableDomain, hostNameLabels, nameMatchesHost } from '../packages/tools/src/domains.ts';

let fail = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
}

console.log('registrableDomain — what a contact provider can actually query:');
eq('plain domain unchanged', registrableDomain('lionsgate.com'), 'lionsgate.com');
eq('strips a subdomain', registrableDomain('jobs.lionsgate.com'), 'lionsgate.com');
eq('strips a deep subdomain', registrableDomain('chnimg.vimoviesandtv.in'), 'vimoviesandtv.in');
eq('keeps a country second level', registrableDomain('tv.movistar.com.ar'), 'movistar.com.ar');
eq('keeps co.uk style', registrableDomain('news.example.co.uk'), 'example.co.uk');
eq('short host untouched', registrableDomain('orf.at'), 'orf.at');
eq('non-registry second label', registrableDomain('m.ixigua.com'), 'ixigua.com');

console.log('\nhostNameLabels — the parts that could carry the brand:');
eq('subdomain and brand both offered', hostNameLabels('moviesandtv.myvi.in'), ['myvi', 'moviesandtv', 'moviesandtvmyvi']);
eq('drops the TLD', hostNameLabels('lionsgate.com'), ['lionsgate']);
eq('drops a country second level', hostNameLabels('tv.movistar.com.ar'), ['movistar', 'tv', 'tvmovistar']);

console.log('\nnameMatchesHost — cases the old first-label-only test got wrong:');
eq('subdomained brand matches', nameMatchesHost('Xigua Video', 'm.ixigua.com'), true);
eq('regional subdomain matches', nameMatchesHost('Movistar TV', 'tv.movistar.com.ar'), true);
eq('careers subdomain matches', nameMatchesHost('Lionsgate Entertainment Inc.', 'jobs.lionsgate.com'), true);
eq('plain match still works', nameMatchesHost('Kaltura', 'kaltura.com'), true);

console.log('\nnameMatchesHost — must still reject:');
// The guard that stops a brand hosted on someone else's platform from filing
// the platform's domain: the name matches the SUBDOMAIN, not the registrable
// domain, so resolveEntityDomain re-tests against what it is about to store.
eq('platform domain rejected for a hosted brand',
  nameMatchesHost('WideKhaliji', registrableDomain('widekhaliji.blueonline.tv')), false);
eq('unrelated company rejected', nameMatchesHost('Kaltura', 'netflix.com'), false);
eq('empty name rejected', nameMatchesHost('', 'kaltura.com'), false);

console.log('\nnameMatchesHost — company trading under its initials:');
// Warner Brothers Discovery really is wbd.com; nothing substring-based can see
// that, and the account sat unreachable despite clearing both score gates.
eq('acronym of 3+ words matches the label', nameMatchesHost('Warner Brothers Discovery', 'wbd.com'), true);
eq('acronym still works with a subdomain', nameMatchesHost('Warner Brothers Discovery', 'careers.wbd.com'), true);
// Guards against the acronym rule being too eager.
eq('two-word initialism does NOT match', nameMatchesHost('Total Play', 'tp.com'), false);
eq('acronym must equal the whole label', nameMatchesHost('Warner Brothers Discovery', 'wbdxyz.com'), false);
eq('unrelated 3-letter host still rejected', nameMatchesHost('Warner Brothers Discovery', 'abc.com'), false);

console.log(fail === 0 ? '\nALL PASS (incl. acronyms)' : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
