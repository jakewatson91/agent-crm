/**
 * PostgREST caps every response at the server's max-rows (1000 here) regardless
 * of .limit(). A bare .limit(20000) silently returns only the first 1000 rows —
 * and without an explicit order, those are the OLDEST in the window. Any read
 * over a high-volume workspace then drops all recent rows, so callers compute on
 * stale/empty data (this is what produced false "enricher silent", "spend=0",
 * "0% coupling", and bogus per-source dead-weight alarms once a workspace passed
 * 1000 rows in a window).
 *
 * fetchAll pages through with .range() so the whole window comes back. The
 * caller MUST apply a stable .order() inside makePage, or range pagination can
 * skip/duplicate rows across pages.
 */
export async function fetchAll<T>(
  makePage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string; details?: string; hint?: string; code?: string } | null }>,
): Promise<T[]> {
  const PAGE = 1000;
  const all: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await makePage(from, from + PAGE - 1);
    if (error) throw new Error(`${error.message}${error.details ? ` | ${error.details}` : ''}${error.hint ? ` | ${error.hint}` : ''}${error.code ? ` [${error.code}]` : ''}`);
    const rows = (data ?? []) as T[];
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  return all;
}

/** Split an id list into batches small enough for a single `.in()` call. */
export function chunk<T>(xs: T[], n = 150): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}
