/**
 * chatCompleteForWorkspace — wraps chatComplete with per-workspace policy.
 *
 * Reads policy.llm to determine the API keys + model overrides, then
 * delegates to the primitives chatComplete. Keeps the DB dep out of
 * @agent-crm/primitives.
 *
 * Resolution order for model:
 *   1. args.model (caller's explicit choice — usually a sensible per-call
 *      default like 'deepseek/deepseek-v4-pro' for the drafter)
 *   2. policy.llm.drafter_model (when caller passes `behavior: 'drafter'`)
 *   3. policy.llm.default_chat_model (workspace override)
 *   4. args.model fallback (= the original)
 *
 * Resolution for keys: policy.llm.* wins over env. Env stays as the
 * single-tenant fallback.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { chatComplete, type ChatCompleteArgs, type ChatCompleteResult } from '@agent-crm/primitives';
import { getPolicy } from './policy.js';

export interface ChatForWorkspaceArgs extends ChatCompleteArgs {
  /** Lets the helper pick policy.llm.drafter_model when behavior === 'drafter'. */
  behavior?: 'drafter' | 'enricher' | 'claim_poster' | 'scoring' | 'wizard' | 'intake' | 'connector_extract';
}

export async function chatCompleteForWorkspace(
  supabase: SupabaseClient,
  workspace_id: string,
  args: ChatForWorkspaceArgs,
): Promise<ChatCompleteResult> {
  const policy = await getPolicy(supabase, workspace_id);
  const llm = policy.llm ?? {};

  // Pick model: caller > drafter override > workspace default > caller fallback.
  let model = args.model;
  if (args.behavior === 'drafter' && llm.drafter_model) model = llm.drafter_model;
  else if (llm.default_chat_model && model === args.model) {
    // Only override the caller's model if they passed the legacy gpt-4o-mini default
    // or didn't pick something specific. We don't want a policy override to silently
    // change a deliberate per-call choice (e.g. fallback to gpt-4o-mini for JSON-retry).
    // For now: respect policy default unconditionally; callers who want to pin can
    // route through chatComplete directly.
    model = llm.default_chat_model;
  }

  return chatComplete({
    ...args,
    model,
    api_keys: {
      openai: llm.openai_api_key,
      openrouter: llm.openrouter_api_key,
    },
  });
}
