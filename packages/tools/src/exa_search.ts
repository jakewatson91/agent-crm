/**
 * Shared Exa /search caller. One place that builds the request, enforces the
 * category constraint, POSTs, and parses — used by both the scheduled connector
 * (connectors/exa.ts) and the per-entity research runner (functions/research.ts).
 *
 * Exa category constraint (verified): the `company` and `people` categories REJECT
 * startPublishedDate / includeDomains / excludeDomains / includeText. The `news`
 * category and *no* category accept them. We only ever pass `news`, so the filters
 * below are always safe; do not add other categories without splitting the request shape.
 */

const EXA_API = 'https://api.exa.ai/search';
const EXA_CONTENTS_API = 'https://api.exa.ai/contents';
const FETCH_TIMEOUT_MS = 15_000;

export interface ExaResult {
  id: string;
  title: string | null;
  url: string;
  publishedDate?: string;
  author?: string;
  text?: string;
  score?: number;
}

export interface ExaSearchParams {
  query: string;
  type?: 'auto' | 'keyword' | 'neural';   // default 'auto'
  num_results?: number;                     // clamped to [1, 100]; default 25
  text_chars?: number;                      // contents.text.maxCharacters; default 1500
  category?: 'news';                        // only 'news' is allowed alongside the filters below
  start_published_date?: string;            // ISO; -> startPublishedDate
  include_domains?: string[];
  exclude_domains?: string[];
  include_text?: string[];                  // Exa caps this at one phrase of <=5 words
}

export interface ExaSearchResult {
  ok: boolean;
  results: ExaResult[];
  status?: number;
  error?: string;
}

export async function runExaSearch(apiKey: string, params: ExaSearchParams): Promise<ExaSearchResult> {
  const reqBody: Record<string, unknown> = {
    query: params.query,
    type: params.type ?? 'auto',
    numResults: Math.min(Math.max(params.num_results ?? 25, 1), 100),
    contents: { text: { maxCharacters: params.text_chars ?? 1500 } },
  };
  if (params.category) reqBody.category = params.category;
  if (params.start_published_date) reqBody.startPublishedDate = params.start_published_date;
  const inc = (params.include_domains ?? []).filter(Boolean);
  const exc = (params.exclude_domains ?? []).filter(Boolean);
  if (inc.length) reqBody.includeDomains = inc;
  if (exc.length) reqBody.excludeDomains = exc;
  // includeText forces a phrase into every result — used to kill same-name slug
  // collisions (e.g. a company name that also matches an unrelated library). Exa
  // accepts a single phrase of at most 5 words.
  const incText = (params.include_text ?? [])
    .map((t) => t.trim()).filter(Boolean)
    .slice(0, 1).map((t) => t.split(/\s+/).slice(0, 5).join(' '));
  if (incText.length) reqBody.includeText = incText;

  try {
    const r = await fetch(EXA_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify(reqBody),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!r.ok) return { ok: false, results: [], status: r.status, error: (await r.text()).slice(0, 300) };
    const j = await r.json() as { results?: ExaResult[] };
    return { ok: true, results: j.results ?? [] };
  } catch (e) {
    return { ok: false, results: [], error: e instanceof Error ? e.message : String(e) };
  }
}

export interface ExaContentsResult {
  ok: boolean;
  url: string;
  title?: string | null;
  text?: string;
  status?: number;
  error?: string;
}

/**
 * Fetch the readable text of one already-known URL via Exa /contents. Used by the
 * qualification loop's fetch_page tool when the model decides to read a specific
 * page (a careers page, a changelog) rather than run another search. Separate from
 * runExaSearch because /contents takes URLs directly and returns no ranking.
 */
export async function fetchPageText(apiKey: string, url: string, maxChars = 4000): Promise<ExaContentsResult> {
  try {
    const r = await fetch(EXA_CONTENTS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ ids: [url], text: { maxCharacters: maxChars } }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!r.ok) return { ok: false, url, status: r.status, error: (await r.text()).slice(0, 300) };
    const j = await r.json() as { results?: ExaResult[] };
    const hit = j.results?.[0];
    if (!hit) return { ok: false, url, error: 'no content returned' };
    return { ok: true, url, title: hit.title, text: hit.text ?? '' };
  } catch (e) {
    return { ok: false, url, error: e instanceof Error ? e.message : String(e) };
  }
}
