/**
 * Chat intake — AI SDK v6 streamText loop with persistent threads.
 *
 * Replaced the hand-rolled SSE + ReAct loop with streamText({ tools, stopWhen,
 * experimental_transform: smoothStream }). Client uses useChat() which speaks
 * the UI Message Stream protocol natively. Reasoning, tool calls, tool
 * results, and abort all come for free.
 *
 * The custom `thread` event (server-generated conversation_id on a fresh
 * thread) rides on the same stream as a transient data part — useChat exposes
 * it on the message.parts array client-side.
 */
import { createServerClient } from '@agent-crm/db';
import { resolveChatModel, getEntityTypesBatch } from '@agent-crm/tools';
import { resolveModel } from '@agent-crm/primitives';
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  jsonSchema,
  smoothStream,
  stepCountIs,
  streamText,
  tool,
  type UIMessage,
} from 'ai';
import type { SupabaseClient } from '@supabase/supabase-js';
import { INTAKE_TOOLS, type ToolRunCtx } from './tools';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_STEPS = 6;
const STORED_CAP = 400;
const RECENT_ENTITY_CAP = 8;

const SYSTEM_PROMPT = `You are the chat agent for an agent-native CRM. The user pastes free-text observations to ingest, or asks open-ended questions about workspace state.

SCOPE OF ACTION (read this first):
  - Answer the user's actual question. Do not take side-actions just because you notice something (a stale source, a missing subscription, a low score). Surface those as observations in your reply, not as tool calls.
  - "Decide-and-notify" applies ONLY to actions the user's message clearly asks for, or the obvious next step the user explicitly invited. If the user is asking a question, you are answering, not acting.
  - Irreversible actions (sending outreach, asserting facts you aren't grounded in) always require explicit user confirmation.

LOOP BUDGET: you get a small number of tool calls per turn. If two attempts in a row return empty or error, STOP and tell the user what you checked and what's missing. Do not try variations of the same query.

READING STATE: use \`query\` for ALL reads. Pick scope + filter.
  - "top entity / best leads"            → query({ scope: "entities", sort: "icp_total desc", limit: 5 })
  - "find / lookup <name>"               → query({ scope: "entities", filter: { name_match: "<name>" } })
  - "tell me about <entity>"             → query({ scope: "entities", filter: { id: "<uuid>" } })
  - "accounts in industry X"             → query({ scope: "entities", filter: { has_fact: { predicate: "industry", object_match: "<term>" } } })
  - "what did the agent do today"        → query({ scope: "events", filter: { action: "agent_action_taken", since_hours: 24 } })
  - "how are sources working"            → query({ scope: "sources" })
  - "what's pending approval"            → query({ scope: "gates", filter: { status: "pending" } })
  - "facts on <entity>"                  → query({ scope: "facts", filter: { subject_entity: "<uuid>" } })
  - "contacts/team/people at <name>"     → query({ scope: "contacts", filter: { account_name: "<name>" } })
  - "contacts for <uuid>"                → query({ scope: "contacts", filter: { account_entity_id: "<uuid>" } })
  - "outbound drafts / templates / what's the agent written" → query({ scope: "drafts", limit: 5 })
  - "drafts for <entity>"                → query({ scope: "drafts", filter: { subject_entity: "<uuid>" } })

CONTACTS / PEOPLE AT AN ACCOUNT:
  - Always use scope:"contacts" for "who's at X", "contacts for X", "the team at X", "people at AI companies."
  - Never answer this with scope:"entities" or scope:"facts" alone — contacts are linked via works_at/is_*_of FKs and email-domain match. Only contacts scope walks both edges.
  - If the result is { linked_count: 0 } AND the account has a real domain, the next reversible step is enrich_contacts({ account_entity_id }). Just run it and report what came back.
  - If the result is { linked_count: 0 } AND domain is null, ask the user for the domain or say it's missing. Do not call enrich_contacts.

INGESTION FLOW for a new observation (paste of free text about a company):
  1. query({ scope: "entities", filter: { name_match: "<name>" } }) to find the subject.
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

THREAD MEMORY: prior turns in this conversation are real — refer back to them by name. If the user says "what did we decide about Acme?" or "them", resolve from earlier turns rather than asking again.

WHEN YOU NEED INFO FROM THE USER: just ask in plain text and stop (no tool call). The user's next message becomes your answer and the loop resumes with full history.

VOICE (structural rules, not phrase lists):
  - Lead with the answer. Do not restate the question, summarize what you just did, or warm up.
  - One short paragraph, or a 3–7 line list. Whichever is denser. Use markdown lists where it helps density.
  - No filler that adds zero information ("here is", "I have", "to help with", "based on what I found", trailing offers of further help).
  - No em dashes anywhere. Periods.
  - Plain English to the user. Field/predicate names are tool-internal — surface them as "fact" / "link" / "role" / "email" in prose, not as snake_case.

ENDINGS:
  - If the data answers the question, just answer. Do not invent a trailing question or a "Next:" action.
  - If a reversible next step is clearly implied by the user's request (e.g. "find contacts at X" followed by 0 results with a real domain → enrich), state it as "Next: <action>" and run it. If it isn't implied by what the user asked, don't volunteer it as a tool call — mention it as an observation only.
  - If the next step is irreversible, present a yes/no or short option list and stop.

EMPTY RESULTS:
  - State what you actually checked (scope + filter), not just "none."
  - If a known reversible recovery exists (e.g., enrich_contacts when contacts=0 and the account has a real domain), pick it as the Next line.
  - If no recovery is available, say what's missing (e.g., "no domain set on this account") instead of asking what to do.

DO NOT:
  - Write facts without explicit user confirmation.
  - Invent facts that aren't in the observation text.
  - Trigger a drafter without checking propose_action first.
  - Hand control back to the user with an open question when a reversible step is available.`;

interface PageContextVisible {
  kind: string;
  id: string;
  label?: string;
}
interface PageContextPayload {
  tab?: string;
  summary?: string;
  visible?: PageContextVisible[];
  data?: Record<string, unknown>;
}
interface IntakeReq {
  workspace_id: string;
  conversation_id?: string;
  messages: UIMessage[];
  page_context?: PageContextPayload;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as IntakeReq | null;
  if (!body?.workspace_id || !Array.isArray(body.messages) || body.messages.length === 0) {
    return new Response(JSON.stringify({ error: 'workspace_id and messages required' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const supabase = createServerClient();
  const actor = { workspace_id: body.workspace_id, actor_kind: 'user' as const, actor_id: 'chat_intake' };
  const ctx: ToolRunCtx = { supabase, actor, workspace_id: body.workspace_id };

  // Resolve/create the thread row. New threads emit conversation_id back to
  // the client via a transient data part so useChat can capture it.
  const { conversation_id, isNew } = await resolveThread(supabase, body.workspace_id, body.conversation_id);

  // Resolve the workspace chat model (default deepseek-v4-pro direct; any model
  // via policy.llm.default_chat_model). DeepSeek routes direct with the
  // workspace key; other vendors route through the AI Gateway.
  const { model: chatModel, deepseekKey } = await resolveChatModel(supabase, body.workspace_id);
  let languageModel;
  try {
    languageModel = resolveModel(chatModel, { deepseek: deepseekKey ?? process.env.DEEPSEEK_API_KEY });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Build dynamic recent-entity hint from the incoming messages (so the model
  // can resolve pronouns like "them"). Walks tool-result parts in the last
  // few turns to harvest entity ids, then loads names from the DB.
  const recentEntityNote = await buildRecentEntityNote(supabase, body.workspace_id, body.messages);

  // Page-context note — tells the agent which tab the user is on and what's
  // visible, so pronouns like "the first one" / "this gate" resolve against
  // what's on screen rather than just chat history.
  const pageContextNote = buildPageContextNote(body.page_context);

  const tools = buildTools(ctx);
  const incomingMessages = body.messages;

  const modelMessages = await convertToModelMessages(incomingMessages);

  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      if (isNew) {
        writer.write({ type: 'data-thread', data: { conversation_id }, transient: true });
      }

      const result = streamText({
        model: languageModel,
        system: [SYSTEM_PROMPT, pageContextNote, recentEntityNote]
          .filter(Boolean)
          .join('\n\n'),
        messages: modelMessages,
        tools,
        stopWhen: stepCountIs(MAX_STEPS),
        experimental_transform: smoothStream({ chunking: 'word' }),
        temperature: 0.2,
      });

      writer.merge(result.toUIMessageStream({ sendReasoning: true }));
    },
    onFinish: async ({ messages: responseMessages }) => {
      // responseMessages = newly generated assistant + tool UIMessages.
      // Persist the full thread (FIFO-trimmed) so a reload shows the same state.
      const fullThread = [...incomingMessages, ...responseMessages];
      const trimmed = fullThread.length > STORED_CAP ? fullThread.slice(-STORED_CAP) : fullThread;
      try {
        await persistThread(supabase, conversation_id, trimmed);
        await writeTurnEvent(supabase, body.workspace_id, conversation_id, responseMessages.length);
      } catch {
        /* best-effort */
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}

// ---------------------------------------------------------------
// Tool binding — wrap each handler in AI SDK's `tool()` helper. The handler
// closes over ctx so workspace + actor stay scoped to this request.
// ---------------------------------------------------------------

function buildTools(ctx: ToolRunCtx): Record<string, ReturnType<typeof tool<unknown, unknown>>> {
  const out: Record<string, ReturnType<typeof tool<unknown, unknown>>> = {};
  for (const [name, handler] of Object.entries(INTAKE_TOOLS)) {
    out[name] = tool<unknown, unknown>({
      description: handler.spec.description,
      inputSchema: jsonSchema(handler.spec.parameters as Record<string, unknown>),
      execute: async (args) => {
        try {
          const result = await handler.run(ctx, args);
          // Truncate to keep tool result token-cheap — same 8000-char cap as before.
          const json = JSON.stringify(result);
          return json.length > 8000 ? json.slice(0, 8000) + '…' : result;
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------
// Thread persistence — UIMessages stored directly so the client can hydrate
// with `setMessages(rows.transcript.messages)` and useChat picks up part
// structure (tool calls, tool results, reasoning) without any conversion.
// ---------------------------------------------------------------

async function resolveThread(
  supabase: SupabaseClient,
  workspace_id: string,
  hint_id: string | undefined,
): Promise<{ conversation_id: string; isNew: boolean }> {
  if (hint_id) {
    const { data } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', hint_id)
      .eq('workspace_id', workspace_id)
      .eq('kind', 'chat')
      .maybeSingle();
    if (data) return { conversation_id: data.id as string, isNew: false };
  }
  const { data: created, error } = await supabase
    .from('conversations')
    .insert({ workspace_id, kind: 'chat', transcript: { messages: [] } })
    .select('id')
    .single();
  if (error || !created) throw new Error(`failed to create chat conversation: ${error?.message ?? 'unknown'}`);
  return { conversation_id: created.id as string, isNew: true };
}

async function persistThread(
  supabase: SupabaseClient,
  conversation_id: string,
  messages: UIMessage[],
): Promise<void> {
  const { error } = await supabase
    .from('conversations')
    .update({ transcript: { messages }, updated_at: new Date().toISOString() })
    .eq('id', conversation_id);
  if (error) throw new Error(`failed to persist thread: ${error.message}`);
}

async function writeTurnEvent(
  supabase: SupabaseClient,
  workspace_id: string,
  conversation_id: string,
  new_message_count: number,
): Promise<void> {
  await supabase.from('events').insert({
    workspace_id,
    actor_kind: 'user',
    actor_id: 'chat_intake',
    action: 'chat.turn',
    target_kind: 'conversation',
    target_id: conversation_id,
    payload: { conversation_id, new_message_count },
  });
}

// ---------------------------------------------------------------
// Page context — snapshot of the tab the user is currently looking at so
// "the first one" / "this gate" resolve against what's on screen, not just
// chat history. Snapshot-at-send-time; not persisted with the transcript.
// ---------------------------------------------------------------

const PAGE_VISIBLE_CAP = 10;

function buildPageContextNote(ctx: PageContextPayload | undefined): string | null {
  if (!ctx || typeof ctx !== 'object') return null;
  const tab = typeof ctx.tab === 'string' ? ctx.tab : null;
  const summary = typeof ctx.summary === 'string' ? ctx.summary : null;
  if (!tab && !summary) return null;

  const lines: string[] = [];
  const header = tab && summary ? `${tab} — ${summary}` : (summary ?? tab ?? '');
  lines.push(`User is currently viewing: ${header}.`);

  if (Array.isArray(ctx.visible) && ctx.visible.length > 0) {
    const rows = ctx.visible
      .slice(0, PAGE_VISIBLE_CAP)
      .filter((v) => v && typeof v.kind === 'string' && typeof v.id === 'string')
      .map((v, i) => `  ${i + 1}. ${v.kind}  ${v.id}${v.label ? `  ${v.label}` : ''}`);
    if (rows.length > 0) {
      lines.push(
        `Top ${rows.length} item${rows.length === 1 ? '' : 's'} currently visible to the user, in display order. Use these ids for "this" / "the first one" / "these". Do NOT infer sort method, total count, or any item not listed here — call the query tool if you need more.`,
      );
      lines.push(...rows);
    }
  }

  if (ctx.data && typeof ctx.data === 'object' && Object.keys(ctx.data).length > 0) {
    // Stringify defensively — keep small.
    try {
      const json = JSON.stringify(ctx.data);
      if (json.length <= 600) lines.push(`Extra: ${json}`);
    } catch { /* ignore */ }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------
// Recent-entity context — walks tool-output parts on recent messages to
// surface ids for pronoun resolution.
// ---------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_ID_KEYS = new Set([
  'entity_id', 'account_id', 'contact_id', 'id',
  'account_entity_id', 'subject_entity', 'contact_entity_id',
]);

async function buildRecentEntityNote(
  supabase: SupabaseClient,
  workspace_id: string,
  messages: UIMessage[],
): Promise<string | null> {
  const recent = messages.slice(-6);
  const ids = new Set<string>();
  for (const m of recent) {
    for (const part of m.parts ?? []) {
      const p = part as Record<string, unknown>;
      // Tool input args + tool output payloads.
      if (typeof p.type === 'string' && p.type.startsWith('tool-')) {
        collectEntityIds(p.input, ids);
        collectEntityIds(p.output, ids);
      }
    }
  }
  if (ids.size === 0) return null;
  const idList = Array.from(ids).slice(0, RECENT_ENTITY_CAP);
  const { data } = await supabase.from('entities').select('id, name').in('id', idList);
  if (!data?.length) return null;
  const typesById = await getEntityTypesBatch(supabase, idList);
  const lines = (data as Array<{ id: string; name: string }>)
    .map((e) => `  ${e.id}  ${(typesById.get(e.id) ?? [])[0] ?? 'entity'}  ${e.name}`)
    .join('\n');
  return `Recently referenced entities in this conversation (use these ids for pronouns like "them" / "the team"):\n${lines}`;
}

function collectEntityIds(node: unknown, into: Set<string>): void {
  if (!node) return;
  if (typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const v of node) collectEntityIds(v, into);
    return;
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (ENTITY_ID_KEYS.has(k) && typeof v === 'string' && UUID_RE.test(v)) {
      into.add(v);
    } else {
      collectEntityIds(v, into);
    }
  }
}
