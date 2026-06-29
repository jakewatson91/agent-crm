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
 * Prices we can cite. Keyed by model id. This is the same rate the benchmark
 * has used since it was first recorded (DeepSeek published pricing, cache-miss
 * input). Add more entries only with a real source string.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  'deepseek-reasoner': {
    label: 'DeepSeek-reasoner (v4)',
    input_per_million: 0.14,
    cache_hit_input_per_million: 0.0028,
    output_per_million: 0.28,
    source: 'api-docs.deepseek.com/quick_start/pricing: deepseek-reasoner (v4 thinking mode), cache-miss input (2026-05)',
  },
  'deepseek-v4-flash': {
    label: 'DeepSeek-v4-flash',
    input_per_million: 0.14,
    cache_hit_input_per_million: 0.0028,
    output_per_million: 0.28,
    source: 'api-docs.deepseek.com/quick_start/pricing: deepseek-v4-flash, cache-miss $0.14 / cache-hit $0.0028 / output $0.28 per 1M (2026-06)',
  },
  'deepseek-v4-pro': {
    label: 'DeepSeek-v4-pro',
    input_per_million: 0.435,
    cache_hit_input_per_million: 0.003625,
    output_per_million: 0.87,
    source: 'api-docs.deepseek.com/quick_start/pricing: deepseek-v4-pro, cache-miss $0.435 / cache-hit $0.003625 / output $0.87 per 1M (2026-06)',
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
