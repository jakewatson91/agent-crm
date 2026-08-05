/**
 * Assertions for the research name gate.
 *
 * No test runner in this repo, so this stands in as the regression guard for
 * the check that decides whether an Exa result is even about the target company
 * before an LLM is paid to judge it.
 *
 * Why it exists: Exa only honours `includeText` on keyword routes. Measured
 * 2026-08-04, `type: 'neural'` returned 3/3 pages with no mention of the target,
 * and `type: 'auto'` (what the runner sends) honoured it on 2 of 3 — so searches
 * for a small brand plus topic words came back full of pages about the topic,
 * and identity was 55% of every drop the relevance gate made.
 *
 * The bias is deliberate and asymmetric: letting junk through costs one LLM
 * judgement (the status quo), dropping a real page costs a signal. Every
 * "abstains" case below is that bias on purpose.
 *
 * Run: tsx scripts/check_name_gate.ts   (exits non-zero on failure)
 */
import { pageMentionsEntity, readEntityAliases } from '../packages/tools/src/research_strategy.ts';
import { buildAliases, matchAlias } from '../inngest/functions/sources/utils.ts';

let fail = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
}

const page = (title: string, url = 'https://example.com/a', text = '') => ({ title, url, text });

console.log('pageMentionsEntity — the real drops this was built for:');
// Live results from the 2026-08-04 run; each was rejected by the LLM as `identity`.
eq('UFC ratings page is not Weyyak',
  pageMentionsEntity('Weyyak', 'weyyak.com', page('McGregor-Holloway Fight Ratings: UFC Card Averaged 6.5 Million Viewers', 'https://variety.com/2026/tv/news/mcgregor-holloway-fight-ratings-ufc-1236812638/')), false);
eq('Naver Chzzk concurrency page is not Weyyak',
  pageMentionsEntity('Weyyak', 'weyyak.com', page("Naver's Chzzk tries again to top 5 million concurrent viewers", 'https://www.digitaltoday.co.kr/en/view/74040/')), false);
eq('ABS-CBN story is not Ab Films TV',
  pageMentionsEntity('Ab Films TV', 'abfilmstv.com', page('ABS-CBN Entertainment, may 55 milyong subscribers na!', 'https://qa.philstar.com/pilipino-star-ngayon/showbiz/2026/07/10/2541151/abs-cbn')), false);

console.log('\nkeeps anything that names the company (a dropped signal is the costly error):');
eq('name in the title', pageMentionsEntity('Cineverse', 'cineverse.com', page('Cineverse Buys Horror-Comedy Portal to Hell')), true);
eq('name only in the body', pageMentionsEntity('GoodShort', 'goodshort.com', page('The Future of Microdramas', 'https://hhbmedia.com/x', 'a panel hosted by GoodShort in Hollywood')), true);
eq('name only in the URL', pageMentionsEntity('GoodShort', 'goodshort.com', page('untitled', 'http://hhbmedia.com/goodshort-presents-the-future-of-microdramas/')), true);
eq('case and spacing differences still match', pageMentionsEntity('AB Films TV', 'abfilmstv.com', page('New releases from abfilmstv')), true);
eq('punctuation in the name is ignored', pageMentionsEntity('Cineverse, Inc.', 'cineverse.com', page('Cineverse reports Q4 results')), true);

console.log('\ndomain root is a second way in — a page need not use the full legal name:');
eq('page says only CBC, entity is CBC/Radio-Canada', pageMentionsEntity('CBC/Radio-Canada', 'cbc.ca', page('CBC announces new streaming tier')), true);
eq('domain root matches when the name does not', pageMentionsEntity('Sudden Streaming Group', 'showmax.com', page('Showmax expands across Africa')), true);

console.log('\na slash in the name is two brands — either half counts:');
// videotron.com's own pages were flagged as the wrong company before this split,
// because the entity is named "Videotron/Quebecor" and its domain root is quebecor.
eq('first half matches', pageMentionsEntity('Videotron/Quebecor', 'quebecor.com', page('Videotron announces partnership with Comcast', 'https://newswire.ca/videotron-comcast')), true);
eq('second half matches', pageMentionsEntity('Videotron/Quebecor', 'quebecor.com', page('Quebecor Inc. reports Q1 results')), true);
eq('spaces around the slash are fine', pageMentionsEntity('ShareChat / QuickTV', 'sharechat.com', page('ShareChat reduces losses by 72%')), true);
eq('neither half present is still a drop', pageMentionsEntity('Videotron/Quebecor', 'quebecor.com', page('Rogers buys a stake in Blue Jays')), false);

console.log('\nbrackets are the same case as the slash:');
eq('parenthesised second brand matches', pageMentionsEntity('Astro (sooka)', 'astro.com.my', page('CelcomDigi, sooka part of StreamMore service', 'https://www.lowyat.net/2026/387099/celcomdigi-sooka-part-of-streammore-service/')), true);
eq('the main brand still matches', pageMentionsEntity('Astro (sooka)', 'astro.com.my', page('Astro reports subscriber growth')), true);

console.log('\naliases cover a company the press only calls by its product:');
// Crazy Maple Studio is covered exclusively as "ReelShort"; without the alias
// every genuine article about it fails both the name and the domain test.
const reelshort = page('ReelShort partners with Globe in the Philippines', 'https://www.hollywoodreporter.com/business/business-news/reelshort-partners-philippines-globe');
eq('without an alias the real article is dropped', pageMentionsEntity('Crazy Maple Studio', 'crazymaplestudios.com', reelshort), false);
eq('with the alias it is kept', pageMentionsEntity('Crazy Maple Studio', 'crazymaplestudios.com', reelshort, ['ReelShort']), true);
eq('an alias does not let an unrelated page through', pageMentionsEntity('Crazy Maple Studio', 'crazymaplestudios.com', page('DramaBox raises a round'), ['ReelShort']), false);

console.log('\nabstains rather than risk a real page (a brand with a short common form is untestable):');
eq('two-character name abstains', pageMentionsEntity('M6', 'm6.fr', page('unrelated article about anything')), true);
eq('empty name with no domain abstains', pageMentionsEntity('', '', page('anything')), true);
// "Warner Brothers Discovery" is reported as "Warner Bros. Discovery" — no
// shared run-together substring. With no domain to anchor on, do not judge.
eq('no domain abstains', pageMentionsEntity('Warner Brothers Discovery', '', page('Warner Bros. Discovery earnings Q1 2026')), true);
eq('no domain abstains even on an unrelated page', pageMentionsEntity('Warner Brothers Discovery', '', page('Rogers buys a stake in Blue Jays')), true);
// Coverage of "OSN+" writes "OSN", never "osnplus" — testing the domain root
// alone threw away every genuine OSN page in the July corpus.
eq('short brand with a longer domain abstains', pageMentionsEntity('OSN+', 'osnplus.com', page('OSN partners with Harmonic to monetize streaming channels')), true);
eq('short brand abstains even on an unrelated page', pageMentionsEntity('M6', 'm6plus.fr', page('unrelated article')), true);
// The acronym-domain rule fires before the name is considered at all.
eq('acronym domain abstains regardless of name length', pageMentionsEntity('Warner Brothers Discovery', 'wbd.com', page('Warner Bros streaming boss insists more is not better')), true);

console.log('\nmalformed input never throws:');
eq('unparseable url is still searched as text', pageMentionsEntity('Weyyak', 'weyyak.com', page('x', 'not a url', 'weyyak launches')), true);
eq('missing title and text', pageMentionsEntity('Weyyak', 'weyyak.com', { url: 'https://example.com/none' }), false);

// An alias is only worth adding to an account if every check that account goes
// through can see it. Before 2026-08-05 only the research gate read
// attributes.aliases: the watch-mode connectors derived their own list from the
// name and domain, so "ReelShort" on the record fixed research and left HN, Exa
// watch, GitHub and Product Hunt still blind to it.
console.log('\nattributes.aliases is read the same way everywhere:');
eq('a well-formed list comes back trimmed', readEntityAliases({ aliases: [' ReelShort ', 'Crazy Maple'] }), ['ReelShort', 'Crazy Maple']);
eq('no attributes at all', readEntityAliases(null), []);
eq('the key is absent', readEntityAliases({ domain: 'crazymaplestudios.com' }), []);
eq('a non-array value is ignored, not coerced', readEntityAliases({ aliases: 'ReelShort' }), []);
eq('non-strings and blanks inside the list are dropped', readEntityAliases({ aliases: ['ReelShort', '', '  ', 42, null] }), ['ReelShort']);

console.log('\nconnectors match on curated aliases, not just derived ones:');
eq('the curated name joins the derived set', buildAliases('Crazy Maple Studio', 'crazymaplestudios.com', ['ReelShort']),
  ['crazy maple studio', 'reelshort', 'crazymaplestudios.com']);
eq('a curated alias matches a mention the name never would',
  matchAlias('ReelShort tops the US app charts', buildAliases('Crazy Maple Studio', 'crazymaplestudios.com', ['ReelShort'])), 'reelshort');
eq('an unrelated page still does not match',
  matchAlias('DramaBox raises a round', buildAliases('Crazy Maple Studio', 'crazymaplestudios.com', ['ReelShort'])), null);
// The 3-char floor and the word-boundary rule are what stop short aliases from
// matching English fragments; a curated alias gets them too, not a bypass.
eq('a curated alias under 3 chars is dropped like any other', buildAliases('M6', 'm6plus.fr', ['M6']), ['m6plus.fr']);
eq('no aliases on the record behaves exactly as before', buildAliases('Cineverse', 'cineverse.com'), ['cineverse', 'cineverse.com']);

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
