/**
 * chatCompleteForWorkspace — wraps chatComplete with per-workspace policy.
 *
 * Reads policy.llm to determine the API keys + model overrides, then
 * delegates to the primitives chatComplete. Keeps the DB dep out of
 * @agent-crm/primitives.
 *
 * Resolution order for model:
 *   1. args.model (caller's explicit choice — usually a sensible per-call
 *      default like 'deepseek-v4-pro' for the drafter)
 *   2. policy.llm.drafter_model (when caller passes `behavior: 'drafter'`)
 *   3. policy.llm.default_chat_model (workspace override)
 *   4. args.model fallback (= the original)
 *
 * Resolution for keys: policy.llm.* wins over env. Env stays as the
 * single-tenant fallback.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { chatComplete, chatCompleteStream, type ChatCompleteArgs, type ChatCompleteResult, type ChatStreamDelta } from '@agent-crm/primitives';
import { getPolicy } from './policy.ts';

export interface ChatForWorkspaceArgs extends ChatCompleteArgs {
  /** Lets the helper pick policy.llm.drafter_model when behavior === 'drafter'. */
  behavior?: 'drafter' | 'enricher' | 'claim_poster' | 'scoring' | 'wizard' | 'intake' | 'connector_extract' | 'curator';
}

async function resolveArgs(
  supabase: SupabaseClient,
  workspace_id: string,
  args: ChatForWorkspaceArgs,
): Promise<ChatCompleteArgs> {
  const policy = await getPolicy(supabase, workspace_id);
  const llm = policy.llm ?? {};

  const envDeepseek     = policy.env?.DEEPSEEK_API_KEY;
  const envDefaultModel = policy.env?.DEFAULT_CHAT_MODEL;
  const envDrafterModel = policy.env?.DRAFTER_MODEL;

  let model = args.model;
  const drafterModel = envDrafterModel || llm.drafter_model;
  const defaultModel = envDefaultModel || llm.default_chat_model;
  if (args.behavior === 'drafter' && drafterModel) model = drafterModel;
  else if (defaultModel && model === args.model) model = defaultModel;

  // Only the deepseek-direct key flows per-call; gateway-routed vendors
  // (anthropic/openai/...) authenticate via AI_GATEWAY_API_KEY in the env.
  return {
    ...args,
    model,
    api_keys: { deepseek: envDeepseek || llm.deepseek_api_key },
  };
}

/**
 * Resolve the deepseek API key for a workspace. Used by the AI SDK migration
 * (chat intake) which constructs the deepseek provider per-request.
 * Returns null if no key is configured.
 */
export async function resolveDeepseekKey(
  supabase: SupabaseClient,
  workspace_id: string,
): Promise<string | null> {
  const policy = await getPolicy(supabase, workspace_id);
  return policy.env?.DEEPSEEK_API_KEY || policy.llm?.deepseek_api_key || null;
}

/**
 * Resolve the chat-intake model + deepseek key for a workspace in one policy
 * read. Model defaults to deepseek-v4-pro direct; a workspace can point chat at
 * any model via policy.llm.default_chat_model (e.g. "anthropic/claude-opus-4-7").
 */
export async function resolveChatModel(
  supabase: SupabaseClient,
  workspace_id: string,
): Promise<{ model: string; deepseekKey: string | null }> {
  const policy = await getPolicy(supabase, workspace_id);
  const model = policy.env?.DEFAULT_CHAT_MODEL || policy.llm?.default_chat_model || 'deepseek/deepseek-v4-pro';
  const deepseekKey = policy.env?.DEEPSEEK_API_KEY || policy.llm?.deepseek_api_key || null;
  return { model, deepseekKey };
}

export async function chatCompleteForWorkspace(
  supabase: SupabaseClient,
  workspace_id: string,
  args: ChatForWorkspaceArgs,
): Promise<ChatCompleteResult> {
  return chatComplete(await resolveArgs(supabase, workspace_id, args));
}

export async function chatCompleteStreamForWorkspace(
  supabase: SupabaseClient,
  workspace_id: string,
  args: ChatForWorkspaceArgs,
  onDelta: (delta: ChatStreamDelta) => void,
): Promise<ChatCompleteResult> {
  return chatCompleteStream(await resolveArgs(supabase, workspace_id, args), onDelta);
}
