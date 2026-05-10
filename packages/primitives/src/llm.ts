/**
 * Shared LLM chat-completion helper. Routes to OpenAI or OpenRouter based on
 * the model id:
 *   - Bare ids (e.g. "gpt-4o-mini")            -> OpenAI direct
 *   - Slash-prefixed ids (e.g. "deepseek/...")  -> OpenRouter
 *
 * Both providers expose an OpenAI-compatible /chat/completions endpoint so the
 * request and response shapes are identical aside from the base URL and auth header.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface ChatCompleteArgs {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  response_format?: { type: 'json_object' | 'text' };
}

export interface ChatCompleteResult {
  text: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;       // OpenAI: from prompt_tokens_details.cached_tokens (0 if no caching)
  provider: 'openai' | 'openrouter';
  model: string;
}

async function callOnce(args: ChatCompleteArgs): Promise<ChatCompleteResult> {
  const isOpenRouter = args.model.includes('/');
  const provider: 'openai' | 'openrouter' = isOpenRouter ? 'openrouter' : 'openai';

  const apiKey = isOpenRouter ? process.env.OPENROUTER_API_KEY : process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error(`Missing ${isOpenRouter ? 'OPENROUTER_API_KEY' : 'OPENAI_API_KEY'} for model ${args.model}`);

  const baseUrl = isOpenRouter ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  if (isOpenRouter) {
    headers['HTTP-Referer'] = 'https://github.com/agent-crm';
    headers['X-Title'] = 'agent-crm';
  }

  const body: Record<string, unknown> = {
    model: args.model,
    messages: args.messages,
  };
  if (args.max_tokens !== undefined) body.max_tokens = args.max_tokens;
  if (args.temperature !== undefined) body.temperature = args.temperature;
  if (args.response_format) body.response_format = args.response_format;

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${provider} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json() as {
    choices: Array<{ message: { content: string } }>;
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      prompt_tokens_details?: { cached_tokens?: number };
    };
  };

  return {
    text: j.choices[0]?.message.content ?? '',
    input_tokens: j.usage.prompt_tokens,
    output_tokens: j.usage.completion_tokens,
    cached_input_tokens: j.usage.prompt_tokens_details?.cached_tokens ?? 0,
    provider,
    model: args.model,
  };
}

const FALLBACK_MODEL = 'gpt-4o-mini';

/**
 * Chat completion with two layers of resilience:
 *   1. Retry once on empty/malformed JSON when response_format=json_object.
 *      OpenRouter open-source models occasionally return empty completions; a single
 *      retry usually gets it right.
 *   2. If the retry still fails AND we're on a non-OpenAI model with json_object,
 *      fall back to gpt-4o-mini. Same prompt, more reliable JSON adherence.
 */
export async function chatComplete(args: ChatCompleteArgs): Promise<ChatCompleteResult> {
  const wantsJson = args.response_format?.type === 'json_object';

  let result = await callOnce(args);
  if (!wantsJson || isValidJson(result.text)) return result;

  // First retry: same model, same prompt.
  result = await callOnce(args);
  if (isValidJson(result.text)) return result;

  // Final fallback: only if we weren't already on the fallback model.
  if (args.model !== FALLBACK_MODEL) {
    const fb = await callOnce({ ...args, model: FALLBACK_MODEL });
    if (isValidJson(fb.text)) return fb;
    return fb; // return whatever we got; caller will surface the error
  }
  return result;
}

function isValidJson(s: string): boolean {
  if (!s || !s.trim()) return false;
  try { JSON.parse(s); return true; } catch { return false; }
}
