/**
 * chatCompleteForWorkspace — wraps chatComplete with per-workspace policy.
 *
 * Reads policy.llm to determine the API keys + model overrides, then
 * delegates to the primitives chatComplete. Keeps the DB dep out of
 * @agent-crm/primitives.
 *
 * Model choice is resolveBehaviorModel(policy, behavior, args.model) — see the
 * order documented there. A call that passes no `behavior` keeps the model its
 * caller chose and cannot be overridden by workspace config, which is the safe
 * reading of "we don't know what this call is for".
 *
 * That last part used to be the opposite. `default_chat_model` was applied to
 * every call whose model matched `args.model`, and since `model` was assigned
 * from `args.model` immediately above, the test was always true: one field
 * named for chat silently repointed the enricher, the scorer, the angle picker
 * and five others. Pinned now by scripts/check_model_routing.ts.
 *
 * Resolution for keys: policy.llm.* wins over env. Env stays as the
 * single-tenant fallback.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { chatComplete, chatCompleteStream, type ChatCompleteArgs, type ChatCompleteResult, type ChatStreamDelta } from '@agent-crm/primitives';
import { getPolicy, resolveBehaviorModel, type ModelBehavior } from './policy.ts';

export interface ChatForWorkspaceArgs extends ChatCompleteArgs {
  /** Which behavior this call is, so policy.llm.models can name a model for it. */
  behavior?: ModelBehavior;
}

async function resolveArgs(
  supabase: SupabaseClient,
  workspace_id: string,
  args: ChatForWorkspaceArgs,
): Promise<ChatCompleteArgs> {
  const policy = await getPolicy(supabase, workspace_id);
  const llm = policy.llm ?? {};

  const model = args.behavior
    ? resolveBehaviorModel(policy, args.behavior, args.model)
    : args.model;

  // Only the deepseek-direct key flows per-call; gateway-routed vendors
  // (anthropic/openai/...) authenticate via AI_GATEWAY_API_KEY in the env.
  return {
    ...args,
    model,
    api_keys: { deepseek: policy.env?.DEEPSEEK_API_KEY || llm.deepseek_api_key },
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
 * any model via policy.llm.models.intake (e.g. "anthropic/claude-opus-4-7"), and
 * the older default_chat_model still works and still means exactly this.
 */
export async function resolveChatModel(
  supabase: SupabaseClient,
  workspace_id: string,
): Promise<{ model: string; deepseekKey: string | null }> {
  const policy = await getPolicy(supabase, workspace_id);
  const model = resolveBehaviorModel(policy, 'intake', 'deepseek/deepseek-v4-pro');
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
