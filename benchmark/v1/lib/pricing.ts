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
    output_per_million: 0.28,
    source: 'api-docs.deepseek.com/quick_start/pricing: deepseek-reasoner (v4 thinking mode), cache-miss input (2026-05)',
  },
};

export const DEFAULT_PRICE: ModelPrice = MODEL_PRICES[BENCHMARK_MODEL];

/** Cost in USD for a single agent action, given its token counts and a price. */
export function cost(input: number, output: number, price: ModelPrice = DEFAULT_PRICE): number {
  return (input * price.input_per_million + output * price.output_per_million) / 1_000_000;
}
