import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { callTool, MODEL_BEHAVIORS } from '@agent-crm/tools';

export const runtime = 'nodejs';

/**
 * POST /api/connectors/models  { workspace_id, models: { <behavior>: id, default: id } }
 *
 * Sets which model id runs each behavior. Stored on policy.llm.models, read by
 * resolveBehaviorModel. Any id the model registry understands works
 * ("deepseek/...", "anthropic/...", ...) — no fixed list, so a workspace can
 * point at whatever it pays for.
 *
 * This used to write two env vars, DEFAULT_CHAT_MODEL and DRAFTER_MODEL, and the
 * settings page labelled the first one "Default (scoring, research, chat)". Two
 * thirds of that label was wrong in opposite directions: it did reach scoring,
 * along with six other behaviors nobody was told about, and it never reached
 * research at all, because the planner, the brief writer and the page filter
 * called the model directly and never read workspace policy. Both fields are
 * still honoured on read so a workspace that set one keeps its setting, and
 * saving from this page migrates it onto the behavior it actually names.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    workspace_id?: string;
    models?: Record<string, string | undefined>;
  } | null;
  if (!body?.workspace_id) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });

  const supabase = createServerClient();
  const existing = await supabase.from('workspaces').select('policy').eq('id', body.workspace_id).maybeSingle();
  if (existing.error) return NextResponse.json({ error: existing.error.message }, { status: 500 });

  const policy = JSON.parse(JSON.stringify(existing.data?.policy ?? {})) as Record<string, unknown>;
  const llm = (policy.llm ?? {}) as Record<string, unknown>;
  policy.llm = llm;
  const models = (llm.models ?? {}) as Record<string, string>;
  llm.models = models;

  // Only keys we know about, so a malformed body cannot write junk behaviors
  // into policy that no resolver will ever read.
  const allowed = new Set<string>([...MODEL_BEHAVIORS.map((b) => b.key), 'default']);
  for (const [key, raw] of Object.entries(body.models ?? {})) {
    if (!allowed.has(key)) continue;
    const v = typeof raw === 'string' ? raw.trim() : '';
    if (v) models[key] = v; else delete models[key];
  }

  // The two legacy fields now live under the behavior they name. Clearing them
  // on save is what stops a stale env var quietly outranking the row the
  // customer just edited — resolveBehaviorModel puts the named legacy field
  // above models.default on purpose, and that would read as the save failing.
  const env = (policy.env ?? {}) as Record<string, string>;
  if ('drafter' in (body.models ?? {})) {
    delete env.DRAFTER_MODEL;
    delete (llm as { drafter_model?: string }).drafter_model;
  }
  if ('intake' in (body.models ?? {})) {
    delete env.DEFAULT_CHAT_MODEL;
    delete (llm as { default_chat_model?: string }).default_chat_model;
  }
  policy.env = env;

  const r = await callTool(
    supabase,
    { workspace_id: body.workspace_id, actor_kind: 'user', actor_id: 'web' },
    'set_workspace_policy',
    { policy },
  );
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  return NextResponse.json({ ok: true, event_id: r.event_id });
}
