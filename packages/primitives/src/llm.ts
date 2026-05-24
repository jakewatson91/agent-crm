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
  // For assistant turns that emitted tool calls. Mirrors OpenAI shape.
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  // For tool-result turns. tool_call_id pairs back to the assistant's tool_calls[].id.
  tool_call_id?: string;
  // Display name on tool turns (OpenAI optional; we always set it for clarity).
  name?: string;
}

export interface ToolSpec {
  /** Function name the model emits in tool_calls. */
  name: string;
  /** One-line description the model reads to decide when to call. */
  description: string;
  /** JSON schema for arguments. Use { type:'object', properties:{...}, required:[...] } */
  parameters: Record<string, unknown>;
}

export interface ChatCompleteArgs {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  response_format?: { type: 'json_object' | 'text' };
  /** When set, enables function calling. Each entry becomes a `tools[].function` spec. */
  tools?: ToolSpec[];
  /** Force a specific tool call or 'auto' (default) / 'none'. */
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  /**
   * Per-call API-key override. If set and the chosen provider's key is here,
   * it wins over process.env. Used by the workspace wrapper to inject the
   * caller's pasted keys without leaking DB knowledge into this package.
   */
  api_keys?: { openai?: string; openrouter?: string; deepseek?: string };
}

export interface ChatCompleteResult {
  text: string;                      // empty string when the model only emitted tool_calls
  tool_calls?: Array<{ id: string; name: string; arguments_json: string }>;
  finish_reason?: string;            // 'stop' | 'tool_calls' | 'length' | ...
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;       // OpenAI: from prompt_tokens_details.cached_tokens (0 if no caching)
  provider: 'openai' | 'openrouter';
  model: string;
}

async function callOnce(args: ChatCompleteArgs): Promise<ChatCompleteResult> {
  const isOpenRouter = args.model.includes('/');
  const provider: 'openai' | 'openrouter' = isOpenRouter ? 'openrouter' : 'openai';

  // Per-call override (set by chatCompleteForWorkspace) beats env. Useful for
  // new customers who paste their own key without redeploying.
  const overrideKey = isOpenRouter ? args.api_keys?.openrouter : args.api_keys?.openai;
  const apiKey = overrideKey || (isOpenRouter ? process.env.OPENROUTER_API_KEY : process.env.OPENAI_API_KEY);
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

  // Re-shape our internal messages into the OpenAI wire format. Tool calls and
  // tool results need special handling — the API rejects messages where role
  // and tool_call_id are mismatched.
  const wireMessages = args.messages.map((m) => {
    const base: Record<string, unknown> = { role: m.role, content: m.content };
    if (m.role === 'assistant' && m.tool_calls?.length) base.tool_calls = m.tool_calls;
    if (m.role === 'tool') {
      if (m.tool_call_id) base.tool_call_id = m.tool_call_id;
      if (m.name) base.name = m.name;
    }
    return base;
  });

  const body: Record<string, unknown> = {
    model: args.model,
    messages: wireMessages,
  };
  if (args.max_tokens !== undefined) body.max_tokens = args.max_tokens;
  if (args.temperature !== undefined) body.temperature = args.temperature;
  if (args.response_format) body.response_format = args.response_format;
  if (args.tools?.length) {
    body.tools = args.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    if (args.tool_choice) body.tool_choice = args.tool_choice;
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${provider} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json() as {
    choices: Array<{
      message: {
        content: string | null;
        tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
      };
      finish_reason?: string;
    }>;
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      prompt_tokens_details?: { cached_tokens?: number };
    };
  };

  const choice = j.choices[0];
  const toolCallsRaw = choice?.message.tool_calls ?? [];
  const tool_calls = toolCallsRaw.length
    ? toolCallsRaw.map((c) => ({ id: c.id, name: c.function.name, arguments_json: c.function.arguments }))
    : undefined;

  return {
    text: choice?.message.content ?? '',
    tool_calls,
    finish_reason: choice?.finish_reason,
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
  const usingTools = (args.tools?.length ?? 0) > 0;

  let result = await callOnce(args);
  // When tools are wired, the model may return tool_calls with empty content;
  // that's a valid response, not a parse failure. Skip the JSON retry path.
  if (usingTools || !wantsJson || isValidJson(result.text)) return result;

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

export type ChatStreamDelta = { kind: 'text' | 'reasoning'; text: string };

/**
 * Streaming variant of chatComplete. Calls onDelta with incremental text
 * chunks as they arrive; tool-call fragments are accumulated server-side and
 * surfaced only in the final return value, since partial tool calls aren't
 * useful to render. The returned ChatCompleteResult matches chatComplete's
 * shape so the ReAct loop can swap between them freely.
 *
 * No retry/fallback layer — streaming + tools is the only path that uses this,
 * and tool-shaped responses don't have the empty-JSON failure mode that
 * chatComplete guards against.
 */
export async function chatCompleteStream(
  args: ChatCompleteArgs,
  onDelta: (delta: ChatStreamDelta) => void,
): Promise<ChatCompleteResult> {
  const isOpenRouter = args.model.includes('/');
  const provider: 'openai' | 'openrouter' = isOpenRouter ? 'openrouter' : 'openai';

  const overrideKey = isOpenRouter ? args.api_keys?.openrouter : args.api_keys?.openai;
  const apiKey = overrideKey || (isOpenRouter ? process.env.OPENROUTER_API_KEY : process.env.OPENAI_API_KEY);
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

  const wireMessages = args.messages.map((m) => {
    const base: Record<string, unknown> = { role: m.role, content: m.content };
    if (m.role === 'assistant' && m.tool_calls?.length) base.tool_calls = m.tool_calls;
    if (m.role === 'tool') {
      if (m.tool_call_id) base.tool_call_id = m.tool_call_id;
      if (m.name) base.name = m.name;
    }
    return base;
  });

  const body: Record<string, unknown> = {
    model: args.model,
    messages: wireMessages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (args.max_tokens !== undefined) body.max_tokens = args.max_tokens;
  if (args.temperature !== undefined) body.temperature = args.temperature;
  if (args.response_format) body.response_format = args.response_format;
  if (args.tools?.length) {
    body.tools = args.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    if (args.tool_choice) body.tool_choice = args.tool_choice;
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(`${provider} ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  let text = '';
  let finishReason: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;

  // Tool-call accumulator: keyed by index since OpenAI streams deltas per
  // index with id only on the first chunk and arguments split across chunks.
  const toolAcc = new Map<number, { id: string; name: string; arguments: string }>();

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const line = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') continue;
      let chunk: {
        choices?: Array<{
          delta?: {
            content?: string | null;
            reasoning?: string | null;            // OpenRouter shape for thinking models
            reasoning_content?: string | null;   // DeepSeek-direct shape
            tool_calls?: Array<{ index: number; id?: string; type?: 'function'; function?: { name?: string; arguments?: string } }>;
          };
          finish_reason?: string | null;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
      };
      try { chunk = JSON.parse(payload); } catch { continue; }

      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      const reasoningChunk = delta?.reasoning ?? delta?.reasoning_content;
      if (reasoningChunk) {
        onDelta({ kind: 'reasoning', text: reasoningChunk });
      }
      if (delta?.content) {
        text += delta.content;
        onDelta({ kind: 'text', text: delta.content });
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const cur = toolAcc.get(tc.index) ?? { id: '', name: '', arguments: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.arguments += tc.function.arguments;
          toolAcc.set(tc.index, cur);
        }
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
        outputTokens = chunk.usage.completion_tokens ?? outputTokens;
        cachedInputTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? cachedInputTokens;
      }
    }
  }

  const tool_calls = toolAcc.size
    ? Array.from(toolAcc.entries())
        .sort(([a], [b]) => a - b)
        .map(([, v]) => ({ id: v.id, name: v.name, arguments_json: v.arguments }))
    : undefined;

  return {
    text,
    tool_calls,
    finish_reason: finishReason,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cached_input_tokens: cachedInputTokens,
    provider,
    model: args.model,
  };
}
