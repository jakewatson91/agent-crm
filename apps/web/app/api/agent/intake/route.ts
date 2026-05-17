/**
 * Global chat intake endpoint (5.5b) — SSE-streaming ReAct loop.
 *
 * The client passes its conversation history each turn; the server runs the
 * loop and streams each step (assistant text, tool_call, tool_result) as
 * Server-Sent Events the moment they're produced. Replaces the prior
 * one-shot JSON response so the user sees the agent thinking step-by-step
 * instead of staring at "thinking…" for 10-30 seconds.
 *
 * Event shape (one JSON object per `data:` line):
 *   { type: 'assistant', message: ChatMessage }
 *   { type: 'tool_result', message: ChatMessage }
 *   { type: 'done', steps: number }
 *   { type: 'error', error: string }
 */
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
  conversation_id?: string;
  history: ChatMessage[];
  message: string;
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
    return new Response(JSON.stringify({ error: 'workspace_id and message required' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const supabase = createServerClient();
  const actor = { workspace_id: body.workspace_id, actor_kind: 'user' as const, actor_id: 'chat_intake' };
  const ctx = { supabase, actor, workspace_id: body.workspace_id };

  const recentHistory = (body.history ?? []).slice(-20);
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...recentHistory,
    { role: 'user', content: body.message },
  ];

  const tools = intakeToolSpecs();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      function send(payload: unknown) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      }

      let steps = 0;
      let finalText = '';

      try {
        while (steps < MAX_STEPS) {
          steps++;

          const res = await chatCompleteForWorkspace(supabase, body.workspace_id, {
            model: INTAKE_MODEL,
            behavior: 'intake',
            messages,
            tools,
            tool_choice: 'auto',
            max_tokens: 1200,
            temperature: 0.2,
          });

          if (res.tool_calls?.length) {
            // Assistant emitted tool calls — push to internal history + stream.
            const assistantMsg: ChatMessage = {
              role: 'assistant',
              content: res.text || '',
              tool_calls: res.tool_calls.map((c) => ({
                id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.arguments_json },
              })),
            };
            messages.push(assistantMsg);
            send({ type: 'assistant', message: assistantMsg });

            // Dispatch tool calls one by one. Stream each result as it lands.
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
              send({ type: 'tool_result', message: toolMsg });
            }
            continue;
          }

          finalText = res.text || '(no response)';
          const finalMsg: ChatMessage = { role: 'assistant', content: finalText };
          send({ type: 'assistant', message: finalMsg });
          break;
        }

        if (steps >= MAX_STEPS && !finalText) {
          send({ type: 'assistant', message: { role: 'assistant', content: '(hit max steps; stopping)' } });
        }
        send({ type: 'done', steps });
      } catch (e) {
        send({ type: 'error', error: e instanceof Error ? e.message : String(e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',  // tell Render's nginx not to buffer
    },
  });
}
