/**
 * v1 benchmark LLM call wrapper.
 *
 * Calls DeepSeek's direct API (not OpenRouter). DeepSeek's chat-completions
 * endpoint exposes reasoning_content separately from content, so we don't lose
 * the actual response when reasoning consumes a lot of output budget.
 *
 * Model id: `deepseek-reasoner` (the v4 reasoning model, equivalent to what
 * production agent-crm calls via OpenRouter as `deepseek/deepseek-v4-pro`).
 */

const MODEL = 'deepseek-reasoner';
const BASE_URL = 'https://api.deepseek.com';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export interface Tool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface LlmCallResult {
  request_body: Record<string, unknown>;
  response_body: unknown;
  content: string | null;
  reasoning_content: string | null;
  tool_calls: Array<{ id: string; name: string; arguments_json: string }>;
  finish_reason: string | undefined;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  model: string;
  latency_ms: number;
}

export async function callDeepSeek(messages: ChatMessage[], tools?: Tool[]): Promise<LlmCallResult> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('Missing DEEPSEEK_API_KEY');

  const body: Record<string, unknown> = {
    model: MODEL,
    messages,
    // deepseek-reasoner returns reasoning_content + content as separate fields.
    // completion_tokens covers both. 6000 gives ample room for reasoning + a
    // verbose final output without truncation.
    max_tokens: 6000,
  };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const t0 = Date.now();
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DeepSeek ${res.status}: ${text.slice(0, 500)}`);
  }
  const json = await res.json() as {
    choices: Array<{
      message: {
        content: string | null;
        reasoning_content?: string | null;
        tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
      };
      finish_reason?: string;
    }>;
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      completion_tokens_details?: { reasoning_tokens?: number };
    };
  };
  const latency_ms = Date.now() - t0;
  const choice = json.choices[0];
  const tool_calls = (choice?.message.tool_calls ?? []).map((c) => ({
    id: c.id,
    name: c.function.name,
    arguments_json: c.function.arguments,
  }));

  return {
    request_body: body,
    response_body: json,
    content: choice?.message.content ?? null,
    reasoning_content: choice?.message.reasoning_content ?? null,
    tool_calls,
    finish_reason: choice?.finish_reason,
    input_tokens: json.usage.prompt_tokens,
    output_tokens: json.usage.completion_tokens,
    reasoning_tokens: json.usage.completion_tokens_details?.reasoning_tokens ?? 0,
    model: MODEL,
    latency_ms,
  };
}

export const V1_MODEL = MODEL;
