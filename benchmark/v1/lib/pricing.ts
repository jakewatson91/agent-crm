/**
 * Shared pricing for the v1 benchmark and the public cost page.
 *
 * The token counts are the measured, fixed data (in runs.jsonl). Price is
 * applied on top. Only prices we can cite a source for go in here. Do NOT
 * invent rates for models we have not verified.
 */

export interface ModelPrice {
  label: string;
  input_per_million: number;
  /** Cache-hit input rate. Optional; falls back to input_per_million when absent. */
  cache_hit_input_per_million?: number;
  output_per_million: number;
  source: string;
}

/** The model the v1 benchmark actually ran on (see lib/llm.ts). */
export const BENCHMARK_MODEL = 'deepseek-reasoner';

/**
 * Prices we can cite. Keyed by model id. Add more entries only with a real
 * source string.
 *
 * These are DeepSeek's off-peak rates under the new tiered pricing, effective
 * 2026-08-16T16:00Z. Peak UTC hours (01:00-04:00 and 06:00-10:00) bill at 2x
 * every rate below — that ratio is exact across all six published numbers.
 * This table has no time dimension (benchmark costs are computed from fixed
 * token counts in runs.jsonl, not live call timestamps), so it reports the
 * off-peak floor; a run that happened to land in a peak window would cost 2x
 * what audit_cost.ts / enrichment_cost_audit.ts print.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  'deepseek-reasoner': {
    label: 'DeepSeek-reasoner (v4)',
    input_per_million: 0.22,
    cache_hit_input_per_million: 0.007,
    output_per_million: 0.66,
    source: 'deepseek.com pricing page: deepseek-reasoner (v4 thinking mode) = deepseek-v4-flash rate, off-peak, cache-miss (2026-08)',
  },
  'deepseek-v4-flash': {
    label: 'DeepSeek-v4-flash',
    input_per_million: 0.22,
    cache_hit_input_per_million: 0.007,
    output_per_million: 0.66,
    source: 'deepseek.com pricing page: deepseek-v4-flash, off-peak, cache-miss $0.22 / cache-hit $0.007 / output $0.66 per 1M (2026-08, effective 2026-08-16T16:00Z)',
  },
  'deepseek-v4-pro': {
    label: 'DeepSeek-v4-pro',
    input_per_million: 0.66,
    cache_hit_input_per_million: 0.022,
    output_per_million: 1.98,
    source: 'deepseek.com pricing page: deepseek-v4-pro, off-peak, cache-miss $0.66 / cache-hit $0.022 / output $1.98 per 1M (2026-08, effective 2026-08-16T16:00Z)',
  },
};

export const DEFAULT_PRICE: ModelPrice = MODEL_PRICES[BENCHMARK_MODEL];

/**
 * Exa web-search API pricing (request-based, not token-based). The research
 * loop and the exa / exa_contacts connectors all bill against this.
 */
export interface ExaPrice {
  label: string;
  search_per_thousand: number;    // $ per 1k search requests
  contents_per_thousand: number;  // $ per 1k pages of text contents
  source: string;
}

export const EXA_PRICE: ExaPrice = {
  label: 'Exa search',
  search_per_thousand: 7,
  contents_per_thousand: 1,
  source: 'exa.ai/pricing: $7/1k search requests, $1/1k content pages (2026-06)',
};

/** Cost of one Exa search that also pulls text contents for `numResults` pages. */
export function exaSearchCost(numResults = 0, p: ExaPrice = EXA_PRICE): number {
  return p.search_per_thousand / 1000 + (numResults * p.contents_per_thousand) / 1000;
}

/**
 * Cost in USD for a single agent action, given its token counts and a price.
 * `cachedInput` is the cache-hit slice of `input` (DeepSeek reports it as a
 * subset of prompt tokens); it is billed at the cheaper cache-hit rate when the
 * price has one. Defaults to 0, so existing callers are unchanged.
 */
export function cost(input: number, output: number, price: ModelPrice = DEFAULT_PRICE, cachedInput = 0): number {
  const hit = Math.min(Math.max(cachedInput, 0), input);
  const miss = input - hit;
  const hitRate = price.cache_hit_input_per_million ?? price.input_per_million;
  return (miss * price.input_per_million + hit * hitRate + output * price.output_per_million) / 1_000_000;
}
