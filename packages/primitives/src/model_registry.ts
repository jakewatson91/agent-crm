/**
 * Single place that turns a model-id string into an AI SDK LanguageModel.
 *
 * Convention (also the per-workspace config contract — set in policy.llm):
 *   "deepseek/<model>"  -> DeepSeek direct (api.deepseek.com).  The default.
 *   "<vendor>/<model>"  -> Vercel AI Gateway: one key (AI_GATEWAY_API_KEY)
 *                          reaches OpenAI, Anthropic, Google, xAI, etc., and the
 *                          gateway translates each vendor's native format.
 *   "<model>" (no slash) -> treated as "deepseek/<model>".
 *
 * Why two paths and not just the gateway: DeepSeek is the high-volume default,
 * so it goes straight to the source — no gateway margin on the calls we make
 * thousands of times a day. Anything else a workspace picks (Claude, GPT, ...)
 * rides the gateway, where one key and zero new code is worth the small markup.
 */
import { createDeepSeek } from '@ai-sdk/deepseek';
import type { LanguageModel } from 'ai';

export interface ModelKeys {
  /** DeepSeek-direct key. Falls back to process.env.DEEPSEEK_API_KEY. */
  deepseek?: string;
}

/** Split "provider/model" (defaulting a bare id to the deepseek provider). */
export function parseModelId(modelId: string): { provider: string; model: string } {
  const id = modelId.includes('/') ? modelId : `deepseek/${modelId}`;
  const slash = id.indexOf('/');
  return { provider: id.slice(0, slash), model: id.slice(slash + 1) };
}

export function resolveModel(modelId: string, keys?: ModelKeys): LanguageModel {
  const { provider, model } = parseModelId(modelId);
  if (provider === 'deepseek') {
    const apiKey = keys?.deepseek ?? process.env.DEEPSEEK_API_KEY;
    if (!apiKey) throw new Error('Missing DEEPSEEK_API_KEY for deepseek-direct model ' + modelId);
    return createDeepSeek({ apiKey })(model);
  }
  // Other vendors: hand the AI SDK the full "vendor/model" string. With
  // AI_GATEWAY_API_KEY set, `ai` routes it through the Vercel AI Gateway.
  return `${provider}/${model}`;
}

/** Short label for telemetry (the `provider` field consumers log). */
export function providerLabel(modelId: string): string {
  return parseModelId(modelId).provider;
}
