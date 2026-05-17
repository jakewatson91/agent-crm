/**
 * Global chat intake endpoint (5.5b). Stateless — the client passes the full
 * conversation history each turn. Runs a ReAct loop server-side:
 *
 *   1. Compose system prompt + history + new user message.
 *   2. Call chatComplete with tools[]. Model emits either tool_calls or text.
 *   3. If tool_calls: execute each (via INTAKE_TOOLS dispatcher), append tool
 *      messages to history, loop.
 *   4. If text + no tool_calls: terminate, return the assistant turn.
 *
 * Bounded to MAX_STEPS iterations so the loop can't run forever. The client
 * receives the complete sequence of assistant turns + tool calls + tool
 * results, so the UI can render the full ReAct trace inline.
 */
import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { type ChatMessage } from '@agent-crm/primitives';
import { chatCompleteForWorkspace } from '@agent-crm/tools';
import { INTAKE_TOOLS, intakeToolSpecs } from './tools';

export const runtime = 'nodejs';
export const maxDuration = 60;

const INTAKE_MODEL = 'deepseek/deepseek-v4-pro';
const MAX_STEPS = 8;

interface IntakeReq {
  workspace_id: string;
  conversation_id?: string;          // optional; client tracks it, server doesn't persist yet
  history: ChatMessage[];            // prior turns excluding the new message
  message: string;                   // the new user message
}

const SYSTEM_PROMPT = `You are an intake agent for an agent-native CRM. The user pastes free-text observations (tweets, news, notes) about companies or people they want to track. Your job: turn each observation into atomic facts on the right entity, recompute the score, and surface the action selector's recommendation. You DO NOT decide for the user — at each irreversible step (writing facts, triggering a draft), pause and ask.

CANONICAL FLOW for a new observation:
  1. lookup_entity(name) to find the subject.
     - 0 matches: ask user "Create new entity <name>?" before create_account.
     - 1 match: proceed.
     - 2+ matches: list them with id + icp_fit, ask user which one.
  2. extract_facts(entity_id, entity_name, text) — proposes atomic facts.
     - Show the proposed facts to the user inline. Ask "Confirm these?" before writing.
  3. assert_facts(entity_id, facts) AFTER user confirms.
  4. rescore_entity(entity_id) immediately after asserting.
  5. propose_action(entity_id) — read the action selector's recommendation.
  6. If action is draft_outreach AND user says go, trigger_drafter(entity_id).
     Otherwise just summarize: "Score 0.55 → 0.78. Action selector says watch_only because <reason>."

VOICE: short, direct, no padding. Bullet-list when proposing facts. Never say "I'd be happy to" or "Let me know if you need anything else."

DO NOT:
  - Write facts without explicit user confirmation.
  - Invent facts that aren't in the observation text.
  - Trigger a drafter without checking propose_action first.
  - Use jargon. Plain English to the user, snake_case predicates to the tools.`;

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as IntakeReq | null;
  if (!body?.workspace_id || !body?.message) {
    return NextResponse.json({ error: 'workspace_id and message required' }, { status: 400 });
  }

  const supabase = createServerClient();
  const actor = { workspace_id: body.workspace_id, actor_kind: 'user' as const, actor_id: 'chat_intake' };
  const ctx = { supabase, actor, workspace_id: body.workspace_id };

  // Build initial message list. Trim history if it's getting long; keep last 20 turns.
  const recentHistory = (body.history ?? []).slice(-20);
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...recentHistory,
    { role: 'user', content: body.message },
  ];

  // Trace = the new turns we'll send back to the client to render + append to
  // their history. We DON'T return the system prompt or prior history.
  const trace: ChatMessage[] = [{ role: 'user', content: body.message }];

  const tools = intakeToolSpecs();
  let steps = 0;
  let finalText = '';

  while (steps < MAX_STEPS) {
    steps++;
    let res;
    try {
      res = await chatCompleteForWorkspace(supabase, body.workspace_id, {
        model: INTAKE_MODEL,
        behavior: 'intake',
        messages,
        tools,
        tool_choice: 'auto',
        max_tokens: 1200,
        temperature: 0.2,
      });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      trace.push({ role: 'assistant', content: `(LLM error: ${errMsg})` });
      return NextResponse.json({ ok: false, error: errMsg, trace });
    }

    // If the assistant emitted tool calls, dispatch them and loop.
    if (res.tool_calls?.length) {
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: res.text || '',
        tool_calls: res.tool_calls.map((c) => ({
          id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.arguments_json },
        })),
      };
      messages.push(assistantMsg);
      trace.push(assistantMsg);

      for (const tc of res.tool_calls) {
        const handler = INTAKE_TOOLS[tc.name];
        let result: unknown;
        if (!handler) {
          result = { error: `unknown tool: ${tc.name}` };
        } else {
          try {
            const parsedArgs = JSON.parse(tc.arguments_json || '{}');
            result = await handler.run(ctx, parsedArgs);
          } catch (e) {
            result = { error: e instanceof Error ? e.message : String(e) };
          }
        }
        const toolMsg: ChatMessage = {
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.name,
          content: JSON.stringify(result).slice(0, 8000),
        };
        messages.push(toolMsg);
        trace.push(toolMsg);
      }
      continue;
    }

    // No tool calls → final response. Stop.
    finalText = res.text || '(no response)';
    trace.push({ role: 'assistant', content: finalText });
    break;
  }

  if (steps >= MAX_STEPS && !finalText) {
    trace.push({ role: 'assistant', content: `(hit max steps; stopping)` });
  }

  return NextResponse.json({ ok: true, trace, steps });
}
