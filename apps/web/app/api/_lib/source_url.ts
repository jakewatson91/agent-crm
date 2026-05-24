export interface StructuredTags {
  signal_source?: string;
  item_url?: string;
  hn_url?: string;
  yc_url?: string;
  url?: string;
  [k: string]: unknown;
}

/**
 * Pick the user-facing URL for a signal based on its source. The connector
 * for each source decides which structured_tags field carries the canonical
 * link; we dispatch on `signal_source` so an HN signal cites the HN thread
 * (not whatever item_url happened to be set), a YC signal cites the YC
 * company page, etc.
 *
 * Falls back through the remaining fields when the preferred one is absent,
 * so partial data still produces *some* link rather than null.
 */
export function pickSourceUrl(tags: StructuredTags | null | undefined): string | null {
  if (!tags) return null;
  const { signal_source, item_url, hn_url, yc_url, url } = tags;
  const fallback = item_url ?? url ?? hn_url ?? yc_url ?? null;
  switch (signal_source) {
    case 'yc':
    case 'yc_directory':
      return yc_url ?? fallback;
    case 'hn':
      return hn_url ?? item_url ?? fallback;
    case 'exa':
      return url ?? item_url ?? fallback;
    case 'web':
    case 'custom_http':
    case 'api_call':
      return url ?? item_url ?? fallback;
    case 'github':
    case 'github_trending':
      return url ?? item_url ?? fallback;
    case 'producthunt':
      return url ?? item_url ?? fallback;
    default:
      return fallback;
  }
}
