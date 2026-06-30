/**
 * Reusable agent loop runner.
 *
 * The one piece of shared scaffolding behind every multi-step (plan -> act ->
 * observe) agent in the system. It is a thin wrapper over the AI SDK's built-in
 * tool loop: when a tool carries an `execute` function and you pass `stopWhen`,
 * `generateText` runs the whole loop itself. The runner adds the parts the loop
 * doesn't give you for free:
 *
 *   - per-step event logging (one `<loop>_step` event per iteration), chained to
 *     a root `<loop>_started` event so the existing provenance walk + replay
 *     cover loop runs, not just single-shot agents.
 *   - token accounting summed across steps, written as an `agent_run_metrics`
 *     event so the existing cost reporting picks loop runs up unchanged.
 *   - hard stop conditions: a step cap, a total-token budget (provider-agnostic,
 *     so no price table lives in code), and a consecutive-empty-result guard that
 *     kills a loop that's spinning on the same failing query.
 *
 * Tools are passed in the same `{ spec, run }` shape the chat agent already uses
 * (apps/web/app/api/agent/intake/tools.ts), so a tool set can be shared between
 * the interactive chat path and an autonomous background path.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { generateText, tool, jsonSchema, stepCountIs, type ToolSet } from 'ai';
import { resolveModel, providerLabel, type ModelKeys, type ToolSpec, type Actor } from '@agent-crm/primitives';

export interface LoopToolCtx {
  supabase: SupabaseClient;
  actor: Actor;
  workspace_id: string;
  /** Root event id of this run. Thread into callTool meta so writes chain back. */
  run_event_id: string | null;
}

export interface LoopTool {
  spec: ToolSpec;
  run: (ctx: LoopToolCtx, args: any) => Promise<unknown>;
}

export type LoopStopReason = 'completed' | 'max_steps' | 'token_budget' | 'empty_streak' | 'error';

export interface RunAgentLoopArgs {
  supabase: SupabaseClient;
  workspace_id: string;
  actor: Actor;
  /** Short id used in event action names + metrics, e.g. 'qualification'. */
  loop_name: string;
  system: string;
  /** Single user turn. The loop keeps its own internal message history. */
  prompt: string;
  tools: Record<string, LoopTool>;
  model: string;
  api_keys?: ModelKeys;
  max_steps?: number;          // default 8
  token_budget?: number;       // default 60000
  max_empty_steps?: number;    // default 2
  max_output_tokens?: number;  // per step; default 2000
  temperature?: number;        // default 0.3
  /** What this run is about — used as the event target so the entity page shows it. */
  target?: { kind: string; id: string };
}

export interface RunAgentLoopResult {
  ok: boolean;
  text: string;
  steps: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  stopped_reason: LoopStopReason;
  run_event_id: string | null;
  error?: string;
}

const TOOL_RESULT_CHAR_CAP = 8000;

export async function runAgentLoop(args: RunAgentLoopArgs): Promise<RunAgentLoopResult> {
  const { supabase, workspace_id, actor, loop_name, system, prompt, model, api_keys, target } = args;
  const maxSteps = args.max_steps ?? 8;
  const tokenBudget = args.token_budget ?? 60_000;
  const maxEmpty = args.max_empty_steps ?? 2;
  const maxOut = args.max_output_tokens ?? 2000;
  const temperature = args.temperature ?? 0.3;
  const targetKind = target?.kind ?? 'workspace';
  const targetId = target?.id ?? workspace_id;

  // Root event: per-step events + any facts the tools assert chain to this id,
  // so a provenance walk from a resulting fact reaches the run that produced it.
  const runEventId = await insertEvent(supabase, {
    workspace_id, actor, action: `${loop_name}_started`,
    target_kind: targetKind, target_id: targetId,
    payload: { loop_name, model, max_steps: maxSteps, token_budget: tokenBudget },
    parent_event_id: null,
  });

  const ctx: LoopToolCtx = { supabase, actor, workspace_id, run_event_id: runEventId };

  // Accumulators read by the stop conditions + written by onStepFinish.
  let inTok = 0, outTok = 0, totTok = 0;
  let emptyStreak = 0;
  let stepIndex = 0;

  const toolset: ToolSet = {};
  for (const [name, t] of Object.entries(args.tools)) {
    toolset[name] = tool({
      description: t.spec.description,
      inputSchema: jsonSchema(t.spec.parameters as Record<string, unknown>),
      execute: async (a: unknown) => {
        try {
          const out = await t.run(ctx, a);
          const s = typeof out === 'string' ? out : JSON.stringify(out);
          if (s.length > TOOL_RESULT_CHAR_CAP) return s.slice(0, TOOL_RESULT_CHAR_CAP) + '…';
          return out;
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
      },
    });
  }

  let stoppedReason: LoopStopReason = 'completed';
  let finalText = '';
  let errMsg: string | undefined;

  try {
    const result = await generateText({
      model: resolveModel(model, api_keys),
      system,
      prompt,
      tools: toolset,
      // Stop on ANY: step cap, token budget exceeded, or a run of empty steps.
      stopWhen: [stepCountIs(maxSteps), () => totTok >= tokenBudget, () => emptyStreak >= maxEmpty],
      temperature,
      maxOutputTokens: maxOut,
      onStepFinish: async (step) => {
        stepIndex++;
        const u = step.usage;
        inTok += u?.inputTokens ?? 0;
        outTok += u?.outputTokens ?? 0;
        totTok += u?.totalTokens ?? ((u?.inputTokens ?? 0) + (u?.outputTokens ?? 0));

        const results = (step.toolResults ?? []) as Array<{ output?: unknown }>;
        const calledTools = (step.toolCalls ?? []).length > 0;
        const allEmpty = results.length > 0 && results.every((r) => isEmptyToolOutput(r.output));
        if (calledTools && allEmpty) emptyStreak++; else emptyStreak = 0;

        await insertEvent(supabase, {
          workspace_id, actor, action: `${loop_name}_step`,
          target_kind: targetKind, target_id: targetId,
          payload: {
            step: stepIndex,
            tool_calls: (step.toolCalls ?? []).map((c: any) => ({ name: c.toolName, args: c.input })),
            text: (step.text ?? '').slice(0, 500),
            tokens: { input: u?.inputTokens ?? 0, output: u?.outputTokens ?? 0 },
            finish_reason: step.finishReason,
          },
          parent_event_id: runEventId,
        }).catch(() => null);
      },
    });
    finalText = result.text ?? '';
  } catch (e) {
    stoppedReason = 'error';
    errMsg = e instanceof Error ? e.message : String(e);
  }

  if (stoppedReason !== 'error') {
    if (totTok >= tokenBudget) stoppedReason = 'token_budget';
    else if (emptyStreak >= maxEmpty) stoppedReason = 'empty_streak';
    else if (stepIndex >= maxSteps) stoppedReason = 'max_steps';
    else stoppedReason = 'completed';
  }

  // Closing event (run summary) + a metrics event so cost aggregation is uniform
  // with the single-shot path's agent_run_metrics.
  await insertEvent(supabase, {
    workspace_id, actor, action: `${loop_name}_finished`,
    target_kind: targetKind, target_id: targetId,
    payload: { steps: stepIndex, stopped_reason: stoppedReason, input_tokens: inTok, output_tokens: outTok, total_tokens: totTok, error: errMsg ?? null },
    parent_event_id: runEventId,
  }).catch(() => null);
  await insertEvent(supabase, {
    workspace_id, actor, action: 'agent_run_metrics',
    target_kind: 'workspace', target_id: workspace_id,
    payload: {
      behavior: loop_name, agent: actor.actor_id, entity_id: target?.id ?? null,
      model, provider: providerLabel(model),
      input_tokens: inTok, output_tokens: outTok, cached_input_tokens: 0,
      steps: stepIndex,
    },
    parent_event_id: runEventId,
  }).catch(() => null);

  return {
    ok: stoppedReason !== 'error',
    text: finalText,
    steps: stepIndex,
    input_tokens: inTok,
    output_tokens: outTok,
    total_tokens: totTok,
    stopped_reason: stoppedReason,
    run_event_id: runEventId,
    error: errMsg,
  };
}

/**
 * A tool result counts as "empty" when it carried no usable content — an error,
 * an empty array, or a stub. A run of these means the loop is stuck, so the
 * empty-streak guard stops it instead of burning the rest of the step budget.
 */
function isEmptyToolOutput(out: unknown): boolean {
  if (out == null) return true;
  let s: string;
  try { s = typeof out === 'string' ? out : JSON.stringify(out); } catch { return false; }
  const t = s.trim();
  if (!t || t === '{}' || t === '[]' || t === '""' || t === 'null') return true;
  if (/"error"\s*:/.test(t) && t.length < 200) return true;
  if (/"(results|facts|contacts|items|hits)"\s*:\s*\[\s*\]/.test(t)) return true;
  return t.length < 15;
}

async function insertEvent(
  supabase: SupabaseClient,
  row: {
    workspace_id: string;
    actor: Actor;
    action: string;
    target_kind: string;
    target_id: string;
    payload: Record<string, unknown>;
    parent_event_id: string | null;
  },
): Promise<string | null> {
  const { data } = await supabase.from('events').insert({
    workspace_id: row.workspace_id,
    actor_kind: row.actor.actor_kind,
    actor_id: row.actor.actor_id,
    action: row.action,
    target_kind: row.target_kind,
    target_id: row.target_id,
    payload: row.payload,
    parent_event_id: row.parent_event_id,
  }).select('id').maybeSingle();
  return data?.id != null ? String(data.id) : null;
}
