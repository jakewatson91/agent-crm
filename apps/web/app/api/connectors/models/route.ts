import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { callTool } from '@agent-crm/tools';

export const runtime = 'nodejs';

/**
 * POST /api/connectors/models  { workspace_id, default_chat_model, drafter_model }
 *
 * Sets which model id runs each job. Stored as DEFAULT_CHAT_MODEL / DRAFTER_MODEL
 * under policy.env, which the loop reads first (chat_workspace.ts). Any id the
 * model registry understands works ("deepseek/...", "anthropic/...", ...) — no
 * fixed list, so a workspace can point at whatever it pays for.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    workspace_id?: string; default_chat_model?: string; drafter_model?: string;
  } | null;
  if (!body?.workspace_id) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });

  const supabase = createServerClient();
  const existing = await supabase.from('workspaces').select('policy').eq('id', body.workspace_id).maybeSingle();
  if (existing.error) return NextResponse.json({ error: existing.error.message }, { status: 500 });

  const policy = JSON.parse(JSON.stringify(existing.data?.policy ?? {})) as Record<string, unknown>;
  const env = (policy.env ?? {}) as Record<string, string>;
  policy.env = env;

  const setOrClear = (name: string, val: string | undefined) => {
    const v = (val ?? '').trim();
    if (v) env[name] = v; else delete env[name];
  };
  setOrClear('DEFAULT_CHAT_MODEL', body.default_chat_model);
  setOrClear('DRAFTER_MODEL', body.drafter_model);

  const r = await callTool(
    supabase,
    { workspace_id: body.workspace_id, actor_kind: 'user', actor_id: 'web' },
    'set_workspace_policy',
    { policy },
  );
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  return NextResponse.json({ ok: true, event_id: r.event_id });
}
