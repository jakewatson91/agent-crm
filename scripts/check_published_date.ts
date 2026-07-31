/**
 * Assertions for the publication-date correction.
 *
 * No test runner in this repo, so this stands in as the regression guard for the
 * logic that decides how old a search result is — and therefore whether a
 * four-year-old article can present itself as today's news.
 *
 * Every URL below marked "live offender" is a real result Exa returned for the
 * Sudden workspace with a fabricated recent date. They are kept verbatim because
 * the failure they caused was visible on the workspace home page.
 *
 * Run: tsx scripts/check_published_date.ts   (exits non-zero on failure)
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { publishedDateFromUrl, resolvePublishedDate, parseContentDate, applyContentDate } from '../packages/tools/src/published_date.ts';

let fail = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
}

/** Day part of the date the gate would end up using. */
function effectiveDay(url: string, provider: string | null): string | null {
  return resolvePublishedDate(url, provider).publishedDate?.slice(0, 10) ?? null;
}

console.log('publishedDateFromUrl — reads a date only when the path really carries one:');
eq('blogger /YYYY/MM/', publishedDateFromUrl('https://teeveetee.blogspot.com/2022/03/launch.html')?.slice(0, 10), '2022-03-01');
eq('news /YYYY/MM/DD/', publishedDateFromUrl('https://www.eltrecetv.com.ar/prende/2026/04/17/en-vivo/')?.slice(0, 10), '2026-04-17');
eq('year digits in a slug are not a date', publishedDateFromUrl('https://www.sabc.co.za/sabc/product/rfp-it-2023-15purchase-ott/'), null);
eq('trailing year-month with no slash', publishedDateFromUrl('https://example.com/archive/2019/08')?.slice(0, 10), '2019-08-01');
eq('year alone is not enough', publishedDateFromUrl('https://example.com/archive/2019/'), null);
eq('month 15 rejected', publishedDateFromUrl('https://example.com/2023/15/post.html'), null);
// Date.UTC rolls Feb 31 over to Mar 3 instead of rejecting it; the round-trip
// check in publishedDateFromUrl is the only thing standing between that and a
// fabricated date. Do not remove it.
eq('impossible day rejected, not rolled over', publishedDateFromUrl('https://example.com/2023/02/31/post.html'), null);
eq('leap day accepted', publishedDateFromUrl('https://example.com/2024/02/29/post.html')?.slice(0, 10), '2024-02-29');
eq('future path date is not a publish date', publishedDateFromUrl('https://example.com/2099/01/post.html'), null);
eq('malformed url survives', publishedDateFromUrl('not a url'), null);

console.log('\nresolvePublishedDate — live offenders: the URL must overrule Exa:');
eq('SABC streaming launch, off by 1612 days',
  effectiveDay('https://teeveetee.blogspot.com/2022/03/launch-of-sabcs-video-streaming-service.html', '2026-07-30T00:00:00.000Z'), '2022-03-01');
eq('SABC news channel, off by 1294 days',
  effectiveDay('https://teeveetee.blogspot.com/2023/01/sabc-set-to-launch-second-sabc-news-tv.html', '2026-07-18T00:00:00.000Z'), '2023-01-01');
eq('SABC COO suspended, off by 888 days',
  effectiveDay('https://teeveetee.blogspot.com/2024/02/sabc-coo-ian-plaatjies-and-tv-boss.html', '2026-07-08T00:00:00.000Z'), '2024-02-01');
eq('local TV news, off by 3944 days',
  effectiveDay('http://mediaconfidential.blogspot.com/2015/07/local-tv-takes-news-to-web-in-fight-for.html', '2026-04-18T00:00:00.000Z'), '2015-07-01');
eq('smallest real conflict seen, 55 days',
  effectiveDay('https://www.eltrecetv.com.ar/eltrece-prende/2026/04/17/prende-en-vivo/', '2026-06-10T00:00:00.000Z'), '2026-04-17');

console.log('\nresolvePublishedDate — must not disturb everything else:');
eq('no url date keeps the provider verbatim',
  effectiveDay('https://example.com/reports/2023-annual-review', '2026-07-01T09:00:00.000Z'), '2026-07-01');
eq('undated evergreen page stays undated (exempt from the floor)',
  effectiveDay('https://example.com/customers/', null), null);
eq('agreement within tolerance keeps the provider timestamp',
  resolvePublishedDate('https://example.com/2026/07/post.html', '2026-07-15T09:30:00.000Z').publishedDate, '2026-07-15T09:30:00.000Z');
eq('a genuinely fresh post is untouched',
  effectiveDay('https://example.com/2026/07/todays-news.html', '2026-07-30T00:00:00.000Z'), '2026-07-30');
eq('provider silent + dated url means the floor can finally see it',
  effectiveDay('https://example.com/2021/05/old-launch.html', null), '2021-05-01');

console.log('\nresolvePublishedDate — reports which date it used:');
eq('overruled results name the url', resolvePublishedDate('https://teeveetee.blogspot.com/2022/03/x.html', '2026-07-30T00:00:00.000Z').source, 'url');
eq('overruled results keep what was wrong',
  resolvePublishedDate('https://teeveetee.blogspot.com/2022/03/x.html', '2026-07-30T00:00:00.000Z').overruledProviderDate, '2026-07-30T00:00:00.000Z');
eq('untouched results claim nothing', resolvePublishedDate('https://example.com/x.html', '2026-07-30T00:00:00.000Z').overruledProviderDate, null);
eq('nothing to go on', resolvePublishedDate('https://example.com/x.html', null).source, 'none');

console.log('\nparseContentDate — only believes a real, plausible YYYY-MM-DD:');
eq('plain date', parseContentDate('2023-04-11')?.slice(0, 10), '2023-04-11');
eq('whitespace tolerated', parseContentDate('  2023-04-11 ')?.slice(0, 10), '2023-04-11');
eq('empty string means the page did not say', parseContentDate(''), null);
eq('prose is not a date', parseContentDate('April 2023'), null);
eq('partial date rejected', parseContentDate('2023-04'), null);
eq('impossible day rejected', parseContentDate('2023-02-31'), null);
eq('future date rejected', parseContentDate('2099-01-01'), null);
eq('absurdly old rejected', parseContentDate('1823-01-01'), null);
eq('non-string survives', parseContentDate(null), null);

console.log('\napplyContentDate — may move a source OLDER or fill a blank, never newer:');
// The whole point: the page's own dateline rescues a source nothing else could date.
eq('fills a blank', applyContentDate(null, '2023-04-11')?.slice(0, 10), '2023-04-11');
eq('overrules a provider date that is far too new', applyContentDate('2026-07-30T00:00:00.000Z', '2022-03-04')?.slice(0, 10), '2022-03-04');
// A model misreading a date must never be able to make stale news look current.
eq('refuses to move a source newer', applyContentDate('2022-03-01T00:00:00.000Z', '2026-07-30'), null);
eq('same story, finer stamp, leaves it alone', applyContentDate('2026-07-15T00:00:00.000Z', '2026-07-10'), null);
eq('nothing reported changes nothing', applyContentDate('2026-07-15T00:00:00.000Z', ''), null);
eq('garbage reported changes nothing', applyContentDate('2026-07-15T00:00:00.000Z', 'last Tuesday'), null);
eq('blank + nothing reported stays blank', applyContentDate(null, ''), null);

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
