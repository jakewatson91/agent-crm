/**
 * Minimal SWR setup: a JSON fetcher that throws on non-2xx, and a hook re-export
 * preconfigured with stale-while-revalidate behavior tuned for this app's pages
 * (workspace tabs that the user flips between repeatedly).
 *
 * Pages that need to refetch after a mutation use `mutate(key)` from `swr`.
 */
import useSWR, { type SWRConfiguration } from 'swr';

export async function jsonFetcher<T = unknown>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`fetch ${url} failed: ${r.status} ${text}`);
  }
  return r.json() as Promise<T>;
}

export const DEFAULT_SWR: SWRConfiguration = {
  fetcher: jsonFetcher,
  // Workspace data: tab switches should feel instant. Tolerate slight staleness.
  revalidateOnFocus: true,
  revalidateIfStale: true,
  keepPreviousData: true,
  dedupingInterval: 2000,
};

export { useSWR };
