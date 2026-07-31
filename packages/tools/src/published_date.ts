/**
 * Works out when a search result was actually published.
 *
 * A search provider reports a published date per result, and that date is a
 * guess. When a page carries no machine-readable date, the provider can fall
 * back to the date it crawled the page or the date the page last changed. Either
 * way a years-old article arrives looking like it was posted this week and walks
 * straight through the freshness floor in functions/research.ts.
 *
 * This is not theoretical. Observed live in the Sudden workspace on 2026-07-31:
 *
 *   https://teeveetee.blogspot.com/2022/03/launch-of-sabcs-video-streaming-service.html
 *   reported published 2026-07-30  (real date: March 2022, off by 1612 days)
 *
 * A March 2022 blog post about a delayed streaming launch became a fact dated
 * today. Across that workspace, every result where the URL and the provider
 * disagreed by more than the tolerance below was the provider making an old page
 * look new. The error only ever runs in that one direction.
 *
 * The correction: most blog and news publishing systems (WordPress, Blogger, and
 * the many news sites that copied the convention) write the publication date into
 * the URL path as /YYYY/MM/ or /YYYY/MM/DD/. A CMS stamps that path at publish
 * time and it never moves afterwards, so where it exists it is better evidence
 * than the provider's guess.
 *
 * This is how search providers behave, not a customer preference, so the rule and
 * its tolerance live in code and are the same for every workspace.
 */

/**
 * A date written as its own path segments. Requires a real month (01-12) so a
 * slug like /rfp-it-2023-15purchase/ or an id pair like /2023/47/ never matches.
 * The day is optional because plenty of sites use /YYYY/MM/ alone.
 */
const CMS_DATE_PATH = /\/((?:19|20)\d{2})\/(0[1-9]|1[0-2])(?:\/(0[1-9]|[12]\d|3[01]))?(?:\/|$)/;

/**
 * How far the provider's date may sit from the URL's before we call it a real
 * disagreement rather than rounding. A URL that carries no day is read as the
 * 1st, so a same-month result can legitimately drift up to ~31 days; providers
 * also stamp a timezone-shifted date. The genuine conflicts measured in live
 * data started at 55 days and ran to 3974, so 45 sits in the empty space between
 * noise and error.
 */
const DRIFT_TOLERANCE_DAYS = 45;

/** A path date more than this far in the future is a coincidence, not a publish date. */
const FUTURE_SLACK_MS = 2 * 86_400_000;

export interface ResolvedPublishedDate {
  /** The date to use. Null when neither the URL nor the provider offered one. */
  publishedDate: string | null;
  /** Which one won. 'none' when there was nothing to go on. */
  source: 'provider' | 'url' | 'none';
  /** The provider's original claim, kept only when the URL overruled it, so an audit can see what was wrong. */
  overruledProviderDate: string | null;
}

/**
 * Read a publication date out of a URL path, or null if it carries none.
 *
 * Returns an ISO timestamp at UTC midnight. A path missing the day is read as
 * the 1st of that month, which is why callers compare with a tolerance rather
 * than for equality.
 */
export function publishedDateFromUrl(url: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const m = pathname.match(CMS_DATE_PATH);
  if (!m) return null;

  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3] ?? '1')];
  const t = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(t)) return null;

  // Date.UTC rolls impossible days over instead of rejecting them: /2023/02/31/
  // silently becomes 2023-03-03. Round-trip the parts to throw those out.
  const d = new Date(t);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;

  // A future path date means the digits meant something other than a date.
  if (t > Date.now() + FUTURE_SLACK_MS) return null;

  return d.toISOString();
}

/**
 * Settle a result's publication date from the URL and whatever the provider said.
 *
 * - URL carries no date: take the provider's word, unchanged. Most results land here.
 * - Provider gave nothing: use the URL's date. This one tightens the gate rather
 *   than loosening it: an undated result is exempt from the freshness floor so
 *   evergreen pages (a customer list, a product page) survive, but a URL of
 *   /2022/03/ says this is a dated post that simply hid its date, not an
 *   evergreen page, so it should face the floor like any other article.
 * - They agree within the tolerance: keep the provider's, which usually carries a
 *   real time of day where the URL only has a date.
 * - They genuinely disagree: the URL wins, and the provider's claim is handed back
 *   so the caller can record what it overruled.
 *
 * The cost of being wrong is lopsided and that shapes the tie-break. Wrongly
 * trusting the provider puts a four-year-old article in front of a founder as
 * today's news. Wrongly trusting the URL drops one search result, and another
 * search runs tomorrow.
 */
export function resolvePublishedDate(
  url: string,
  providerDate: string | null | undefined,
): ResolvedPublishedDate {
  const fromUrl = publishedDateFromUrl(url);
  const providerMs = providerDate ? Date.parse(providerDate) : NaN;
  const hasProvider = Number.isFinite(providerMs);

  if (!fromUrl) {
    return {
      publishedDate: hasProvider ? providerDate! : null,
      source: hasProvider ? 'provider' : 'none',
      overruledProviderDate: null,
    };
  }
  if (!hasProvider) {
    return { publishedDate: fromUrl, source: 'url', overruledProviderDate: null };
  }

  const driftDays = Math.abs(providerMs - Date.parse(fromUrl)) / 86_400_000;
  if (driftDays <= DRIFT_TOLERANCE_DAYS) {
    return { publishedDate: providerDate!, source: 'provider', overruledProviderDate: null };
  }
  return { publishedDate: fromUrl, source: 'url', overruledProviderDate: providerDate! };
}

/** Earliest date we will believe. Anything before this is a misread, not a publication. */
const EARLIEST_PLAUSIBLE_MS = Date.UTC(1995, 0, 1);

/**
 * A date the enricher read off the page itself, as YYYY-MM-DD, or null if it
 * reported nothing usable. Rejects anything in the future or absurdly old, both
 * of which mean the model misread a number rather than found a date.
 */
export function parseContentDate(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.trim().match(/^((?:19|20)\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(year, month - 1, day);
  const d = new Date(t);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  if (t > Date.now() + FUTURE_SLACK_MS || t < EARLIEST_PLAUSIBLE_MS) return null;
  return d.toISOString();
}

/** A value carrying a plausible four-digit year is a date, however it is written. */
const CARRIES_A_YEAR = /(?:19|20)\d{2}/;

/**
 * A date the model read off the page that parseContentDate refused, or null.
 *
 * parseContentDate takes ISO and nothing else, so a model that hands back the
 * page's own format is dropped exactly as if the page had carried no date. The
 * two outcomes are indistinguishable downstream and the raw model output is kept
 * nowhere, so the second one leaves no trace: the source silently keeps the
 * search provider's wrong date and there is nothing to grep for afterwards.
 * Observed live on a French press release whose header read
 * "Communiqué de presse du 23/04/2026" and whose signal kept a crawl date.
 *
 * A value with no year in it is the model answering in words ("unknown", "n/a",
 * "last Tuesday"). That is the model saying the page gave nothing, not a failure
 * worth recording, so it returns null. A value carrying a year is a date we
 * failed to read, and the caller records it.
 */
export function unreadableContentDate(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || parseContentDate(trimmed)) return null;
  return CARRIES_A_YEAR.test(trimmed) ? trimmed : null;
}

/**
 * Fold a date printed on the page into what we already believe.
 *
 * The page's own dateline is the best evidence there is, but it reaches us
 * through a model that can misread, so it is allowed to move a source in one
 * direction only: OLDER, never newer.
 *
 * That asymmetry is deliberate. Every date error measured in live data made an
 * old page look new, so moving older corrects the real failure. A model that
 * misreads in the other direction can then only cost us one search result, never
 * put stale news in front of a prospect. Filling a blank is the same trade: an
 * undated source is exempt from the freshness floor, so giving it a date can only
 * ever subject it to more scrutiny.
 *
 * Returns null when nothing should change.
 */
export function applyContentDate(
  currentDate: string | null | undefined,
  contentDateRaw: string | null | undefined,
): string | null {
  const content = parseContentDate(contentDateRaw);
  if (!content) return null;
  if (!currentDate) return content;

  const currentMs = Date.parse(currentDate);
  if (!Number.isFinite(currentMs)) return content;

  const contentMs = Date.parse(content);
  if (contentMs >= currentMs) return null;                              // never moves a source newer
  if (currentMs - contentMs <= DRIFT_TOLERANCE_DAYS * 86_400_000) return null;  // same story, finer stamp
  return content;
}
