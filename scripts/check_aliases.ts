/**
 * Assertions for the alias guards.
 *
 * An alias WIDENS the research name gate, so a bad one silently readmits exactly
 * the junk the gate exists to remove. That failure is invisible — the account
 * looks like it is working, and the corpus fills with pages about other
 * companies. A missing alias is visible: the account has no signals.
 *
 * So the guards are deliberately biased toward rejecting, and these assertions
 * pin the bias. The extraction step above them is a model call and cannot be
 * asserted; these rules are the only part that can, which is the whole reason
 * they are pure functions.
 *
 * Run: tsx scripts/check_aliases.ts   (exits non-zero on failure)
 */
import { validateAliases, usedAsProperNoun, ALIAS_MIN_CHARS, MAX_ALIASES } from '../packages/tools/src/aliases.ts';

let fail = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
}

// The case the whole feature exists for. Crazy Maple Studio's own site presents
// ReelShort; its coverage never uses the registered name.
const CRAZY_MAPLE_SITE =
  'Crazy Maple Studio is a mobile entertainment company. Our flagship app ReelShort brings short drama to a global audience. ReelShort was the top-grossing entertainment app in 2025. We also publish Chapters, an interactive story app.';

console.log('the case this exists for:');
eq('the product name the press uses is accepted',
  validateAliases(['ReelShort'], 'Crazy Maple Studio', 'crazymaplestudios.com', CRAZY_MAPLE_SITE).accepted, ['ReelShort']);
eq('a second product on the same site is accepted too',
  validateAliases(['ReelShort', 'Chapters'], 'Crazy Maple Studio', 'crazymaplestudios.com', CRAZY_MAPLE_SITE).accepted,
  ['ReelShort', 'Chapters']);

console.log('\nguards that stop an alias from widening the gate:');
// The failure that would poison the corpus: a category word lifted off the site.
// "short drama" and "mobile entertainment" appear verbatim, but never as names.
eq('a category phrase on the page is rejected as generic',
  validateAliases(['short drama'], 'Crazy Maple Studio', 'crazymaplestudios.com', CRAZY_MAPLE_SITE).rejected,
  [{ alias: 'short drama', reason: 'generic' }]);
eq('a name the site never states is rejected as absent',
  validateAliases(['DramaBox'], 'Crazy Maple Studio', 'crazymaplestudios.com', CRAZY_MAPLE_SITE).rejected,
  [{ alias: 'DramaBox', reason: 'absent' }]);
// Under the gate's floor, so storing it would record a fix that never fires.
eq('a candidate under the character floor is rejected',
  validateAliases(['CMS'], 'Crazy Maple Studio', 'crazymaplestudios.com', 'Our CMS brand is well known').rejected,
  [{ alias: 'CMS', reason: 'too_short' }]);
eq('the floor matches the name gate', ALIAS_MIN_CHARS, 4);

console.log('\nan alias the gate already matches is not worth storing:');
eq('a longer form of the company name is redundant',
  validateAliases(['Cineverse Networks'], 'Cineverse', 'cineverse.com', 'Cineverse Networks announced results').rejected,
  [{ alias: 'Cineverse Networks', reason: 'redundant' }]);
eq('the domain root itself is redundant',
  validateAliases(['Cineverse'], 'Cineverse, Inc.', 'cineverse.com', 'Cineverse reports Q4').rejected,
  [{ alias: 'Cineverse', reason: 'redundant' }]);
// Bracket and slash halves are gate tokens too, so neither half is worth storing.
eq('a bracketed second brand is already matched by the gate',
  validateAliases(['sooka'], 'Astro (sooka)', 'astro.com.my', 'sooka is our streaming service').rejected,
  [{ alias: 'sooka', reason: 'redundant' }]);

console.log('\nduplicates and bounds:');
eq('an alias the account already carries is not re-added',
  validateAliases(['ReelShort'], 'Crazy Maple Studio', 'crazymaplestudios.com', CRAZY_MAPLE_SITE, ['reelshort']).rejected,
  [{ alias: 'ReelShort', reason: 'duplicate' }]);
eq('the same candidate twice in one batch is added once',
  validateAliases(['ReelShort', 'Reel Short'], 'Crazy Maple Studio', 'crazymaplestudios.com', CRAZY_MAPLE_SITE).accepted,
  ['ReelShort']);
eq('the stored list is bounded',
  validateAliases(
    ['Alpha One', 'Beta Two', 'Gamma Three', 'Delta Four', 'Epsilon Five', 'Zeta Six'],
    'Holdco', 'holdco.example',
    'Our brands are Alpha One and Beta Two and Gamma Three and Delta Four and Epsilon Five and Zeta Six',
  ).accepted.length, MAX_ALIASES);
eq('blanks are skipped, not rejected',
  validateAliases(['', '   '], 'Crazy Maple Studio', 'crazymaplestudios.com', CRAZY_MAPLE_SITE),
  { accepted: [], rejected: [] });

console.log('\nusedAsProperNoun — capitalization away from a sentence start:');
eq('mid-sentence capital is a name', usedAsProperNoun('ReelShort', 'The app ReelShort tops the charts'), true);
// A sentence always capitalizes its first word, so that position proves nothing.
eq('sentence-initial capital proves nothing', usedAsProperNoun('Streaming', 'Streaming is our business.'), false);
eq('a lowercase common word is not a name', usedAsProperNoun('streaming', 'we build streaming apps'), false);
eq('an all-caps acronym counts', usedAsProperNoun('HBO', 'the HBO deal closed'), true);
eq('spacing differences still match', usedAsProperNoun('ReelShort', 'the Reel Short app'), true);
eq('a name only ever opening a sentence is unproven', usedAsProperNoun('Chapters', 'Chapters is an app. Chapters grew fast.'), false);
eq('a bullet or pipe counts as a sentence start', usedAsProperNoun('Products', 'Home | Products | About'), false);
eq('empty inputs never throw', usedAsProperNoun('', ''), false);
eq('a word not on the page is not a name', usedAsProperNoun('ReelShort', 'nothing relevant here'), false);

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
