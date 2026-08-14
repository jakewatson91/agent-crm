/**
 * Shared LLM chat-completion helper, backed by the Vercel AI SDK.
 *
 * The model-id string decides the provider (see model_registry.ts):
 *   "deepseek/..." → DeepSeek direct, anything else → AI Gateway (one key,
 *   handles Anthropic/OpenAI/Google/... including their non-OpenAI formats).
 *
 * The public surface (ChatCompleteArgs / ChatCompleteResult / chatComplete /
 * chatCompleteStream) is unchanged, so callers built on the old fetch wrapper
 * keep working. Messages and tools are translated to the AI SDK shapes here.
 */
import {
  generateText,
  streamText,
  tool,
  jsonSchema,
  stepCountIs,
  APICallError,
  type ModelMessage,
  type ToolSet,
} from 'ai';
import { resolveModel, providerLabel, type ModelKeys } from './model_registry.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  // For assistant turns that emitted tool calls. Mirrors OpenAI shape.
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  // For tool-result turns. tool_call_id pairs back to the assistant's tool_calls[].id.
  tool_call_id?: string;
  // Display name on tool turns.
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
   * Per-call key override (set by chatCompleteForWorkspace) so a workspace can
   * inject its own pasted key without redeploying. Only `deepseek` is read here;
   * gateway-routed vendors authenticate via AI_GATEWAY_API_KEY.
   */
  api_keys?: ModelKeys;
  /**
   * Whether the model thinks before it answers. Leave unset for anything that
   * writes, judges, or plans. Set 'disabled' when the answer is a short fixed
   * shape — a verdict, a label, a number, a mapping — because thinking tokens
   * are billed as output AND counted against max_tokens, so a small ceiling on
   * a reasoning model returns nothing at all.
   *
   * Measured on the relevance gate, one batch of 10 pages, deepseek-v4-flash:
   * thinking on spent all 900 tokens on reasoning and returned an empty string
   * (the batch was then dropped unjudged); the retry at 4000 did the same; the
   * fallback model did the same. Thinking off answered the same batch in 149
   * tokens and 2.1 seconds. On the batches where thinking on did finish, it
   * cost ~4,400 tokens and 33 seconds for a verdict that differed on 1 page in
   * 10. So this is not a quality/cost trade at the margin — for fixed-shape
   * answers the thinking is close to pure waste.
   */
  thinking?: 'enabled' | 'disabled';
}

export interface ChatCompleteResult {
  text: string;                      // empty string when the model only emitted tool_calls
  tool_calls?: Array<{ id: string; name: string; arguments_json: string }>;
  finish_reason?: string;            // 'stop' | 'tool-calls' | 'length' | ...
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;       // 0 when the provider doesn't report prompt caching
  provider: string;                  // 'deepseek', 'anthropic', 'openai', ... (from the model id)
  model: string;
}

// ---------------------------------------------------------------
// Translation: our message/tool shapes <-> AI SDK shapes.
// ---------------------------------------------------------------

function extractSystem(messages: ChatMessage[]): { system: string | undefined; rest: ChatMessage[] } {
  // Bind the element once instead of indexing twice: under noUncheckedIndexedAccess
  // a length check does not narrow messages[0], so both reads were errors. Same
  // behaviour, and it lets `pnpm -r typecheck` get past this package.
  const first = messages[0];
  if (first && first.role === 'system') {
    return { system: first.content, rest: messages.slice(1) };
  }
  return { system: undefined, rest: messages };
}

function toModelMessages(messages: ChatMessage[]): ModelMessage[] {
  return messages.map((m): ModelMessage => {
    if (m.role === 'system') return { role: 'system', content: m.content };
    if (m.role === 'user') return { role: 'user', content: m.content };
    if (m.role === 'tool') {
      // The OpenAI-style tool turn carries one result string; AI SDK wants a
      // typed output part keyed back to the originating tool call.
      return {
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: m.tool_call_id ?? '',
          toolName: m.name ?? '',
          output: { type: 'text', value: m.content },
        }],
      };
    }
    // assistant
    if (m.tool_calls?.length) {
      const parts: Array<Record<string, unknown>> = [];
      if (m.content) parts.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls) {
        let input: unknown = {};
        try { input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { input = {}; }
        parts.push({ type: 'tool-call', toolCallId: tc.id, toolName: tc.function.name, input });
      }
      return { role: 'assistant', content: parts } as ModelMessage;
    }
    return { role: 'assistant', content: m.content };
  });
}

function toToolSet(specs: ToolSpec[] | undefined): ToolSet | undefined {
  if (!specs?.length) return undefined;
  const out: ToolSet = {};
  for (const s of specs) {
    // No `execute`: the model returns the tool call and stops; the caller's
    // ReAct loop runs it and feeds the result back as a tool message.
    out[s.name] = tool({
      description: s.description,
      inputSchema: jsonSchema(s.parameters),
    });
  }
  return out;
}

function toToolChoice(tc: ChatCompleteArgs['tool_choice']) {
  if (!tc || tc === 'auto') return undefined;
  if (tc === 'none') return 'none' as const;
  return { type: 'tool' as const, toolName: tc.function.name };
}

// ---------------------------------------------------------------
// Non-streaming completion.
// ---------------------------------------------------------------

const FALLBACK_MODEL = 'deepseek/deepseek-v4-pro';

/** Attempts per call: the first try plus this many. */
const TRANSPORT_RETRIES = 2;
/** Wait before retry n, in ms: 400, then 800. Long enough to clear a blip, short enough that a background run doesn't stall. */
const RETRY_BACKOFF_MS = 400;

/**
 * Statuses where trying again cannot help, because the provider is telling us
 * something a person has to fix: 400 malformed request, 401 bad key, 402 out of
 * credit, 403 not allowed, 404 unknown model id. Repeating those just delays
 * the error an operator needs to see.
 */
const PERMANENT_STATUS = new Set([400, 401, 402, 403, 404]);

/**
 * Is this failure worth another attempt with the same request?
 *
 * generateText already retries what the SDK marks retryable (429, 5xx). The
 * gap is the one it marks NOT retryable but that a repeat almost always fixes:
 * the provider answers 200 and the SDK cannot parse the body, which it reports
 * as APICallError("Failed to process successful response") with statusCode 200,
 * so isRetryable is false and it gives up on the spot. Measured over the 24h to
 * 2026-08-12 that killed 12 of 69 enricher runs and 3 of 52 scoring runs on
 * deepseek-v4-flash, every one of them terminal: agentRun writes
 * agent_llm_failed and skips, so no fallback model and no second try.
 *
 * Anything that is not a provider call failure (a missing key, an abort, a bug
 * in our own code) is left alone — looping on those hides them.
 */
export function isWorthRetrying(e: unknown): boolean {
  if (!APICallError.isInstance(e)) return false;
  if (e.statusCode != null && PERMANENT_STATUS.has(e.statusCode)) return false;
  return true;
}

/**
 * callOnce, with the transport retry above. `call` is a parameter so the
 * assertions in scripts/check_llm_retry.ts can count attempts without a network.
 */
export async function callWithRetry(
  args: ChatCompleteArgs,
  call: (a: ChatCompleteArgs) => Promise<ChatCompleteResult> = callOnce,
): Promise<ChatCompleteResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call(args);
    } catch (e) {
      if (attempt >= TRANSPORT_RETRIES || !isWorthRetrying(e)) throw e;
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * (attempt + 1)));
    }
  }
}

/**
 * The `thinking` setting on the wire. DeepSeek reads `thinking.type` in the
 * request body (the AI SDK's deepseek provider serializes it from here);
 * options under a provider key another vendor doesn't own are dropped, so a
 * workspace that points a call at Claude or GPT is unaffected.
 *
 * Exported for scripts/check_thinking_off.ts: the shape is the whole fix, and a
 * typo in it fails silently — the call just goes back to thinking.
 */
export function providerOptionsFor(args: ChatCompleteArgs) {
  if (!args.thinking) return undefined;
  return { deepseek: { thinking: { type: args.thinking } } };
}

async function callOnce(args: ChatCompleteArgs): Promise<ChatCompleteResult> {
  const tools = toToolSet(args.tools);
  const { system, rest } = extractSystem(args.messages);
  const res = await generateText({
    model: resolveModel(args.model, args.api_keys),
    system,
    messages: toModelMessages(rest),
    maxOutputTokens: args.max_tokens,
    temperature: args.temperature,
    tools,
    toolChoice: tools ? toToolChoice(args.tool_choice) : undefined,
    providerOptions: providerOptionsFor(args),
  });

  const tool_calls = res.toolCalls?.length
    ? res.toolCalls.map((c) => ({ id: c.toolCallId, name: c.toolName, arguments_json: JSON.stringify(c.input ?? {}) }))
    : undefined;

  return {
    text: res.text ?? '',
    tool_calls,
    finish_reason: res.finishReason,
    input_tokens: res.usage?.inputTokens ?? 0,
    output_tokens: res.usage?.outputTokens ?? 0,
    cached_input_tokens: res.usage?.cachedInputTokens ?? 0,
    provider: providerLabel(args.model),
    model: args.model,
  };
}

/**
 * Chat completion with JSON resilience:
 *   0. Every attempt below retries a provider blip up to TRANSPORT_RETRIES times.
 *   1. Retry once on empty/malformed JSON when response_format=json_object.
 *   2. If still bad and not already on it, fall back to deepseek-v4-pro.
 * Tool-shaped responses skip 1 and 2 (empty content alongside tool_calls is valid).
 *
 * Step 1 only ever ran when the call returned. When it threw instead, the error
 * went straight to the caller and the run was over, which is what callWithRetry
 * now covers. chatCompleteStream is deliberately left without it: it is the
 * interactive chat path, where a retry would replay text the user already saw
 * and the user can just ask again.
 */
export async function chatComplete(
  args: ChatCompleteArgs,
  call: (a: ChatCompleteArgs) => Promise<ChatCompleteResult> = callOnce,
): Promise<ChatCompleteResult> {
  const wantsJson = args.response_format?.type === 'json_object';
  const usingTools = (args.tools?.length ?? 0) > 0;

  let result = await callWithRetry(args, call);
  if (usingTools || !wantsJson || isValidJson(result.text)) return result;

  // Empty/non-JSON on a json_object call almost always means a reasoning model
  // spent its entire output budget on reasoning before emitting any content.
  // The retry + fallback only help if they get more room than the first try —
  // same budget = same failure. Give content space after reasoning.
  // Both rungs keep the caller's `thinking` setting. Dropping it here would put
  // the retry back on the reasoning path the first call was trying to escape,
  // which is the failure this whole ladder exists to catch.
  const roomy: ChatCompleteArgs = { ...args, max_tokens: Math.max((args.max_tokens ?? 1024) * 3, 4000) };
  result = await callWithRetry(roomy, call);
  if (isValidJson(result.text)) return result;

  if (args.model !== FALLBACK_MODEL) {
    const fb = await callWithRetry({ ...roomy, model: FALLBACK_MODEL }, call);
    return fb; // return whatever we got; caller surfaces the error
  }
  return result;
}

function isValidJson(s: string): boolean {
  if (!s || !s.trim()) return false;
  try { JSON.parse(s); return true; } catch { return false; }
}

// ---------------------------------------------------------------
// Streaming completion (used by the ReAct loop in chat intake).
// ---------------------------------------------------------------

export type ChatStreamDelta = { kind: 'text' | 'reasoning'; text: string };

export async function chatCompleteStream(
  args: ChatCompleteArgs,
  onDelta: (delta: ChatStreamDelta) => void,
): Promise<ChatCompleteResult> {
  const tools = toToolSet(args.tools);
  const { system, rest } = extractSystem(args.messages);
  const result = streamText({
    model: resolveModel(args.model, args.api_keys),
    system,
    messages: toModelMessages(rest),
    maxOutputTokens: args.max_tokens,
    temperature: args.temperature,
    tools,
    toolChoice: tools ? toToolChoice(args.tool_choice) : undefined,
    // Single model turn: stop once the model finishes (it stops itself on a
    // tool call since the tools have no execute). The caller drives the loop.
    stopWhen: stepCountIs(1),
  });

  for await (const part of result.fullStream) {
    const p = part as { type: string; text?: string; delta?: string };
    if (p.type === 'text-delta') {
      const t = p.text ?? p.delta ?? '';
      if (t) onDelta({ kind: 'text', text: t });
    } else if (p.type === 'reasoning-delta') {
      const t = p.text ?? p.delta ?? '';
      if (t) onDelta({ kind: 'reasoning', text: t });
    }
  }

  const [text, toolCalls, usage, finishReason] = await Promise.all([
    result.text,
    result.toolCalls,
    result.usage,
    result.finishReason,
  ]);

  const tool_calls = toolCalls?.length
    ? toolCalls.map((c) => ({ id: c.toolCallId, name: c.toolName, arguments_json: JSON.stringify(c.input ?? {}) }))
    : undefined;

  return {
    text: text ?? '',
    tool_calls,
    finish_reason: finishReason,
    input_tokens: usage?.inputTokens ?? 0,
    output_tokens: usage?.outputTokens ?? 0,
    cached_input_tokens: usage?.cachedInputTokens ?? 0,
    provider: providerLabel(args.model),
    model: args.model,
  };
}
