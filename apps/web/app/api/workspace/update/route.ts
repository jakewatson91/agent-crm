import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { callTool } from '@agent-crm/tools';

export const runtime = 'nodejs';

interface UpdateReq {
  workspace_id: string;
  persona?: Record<string, unknown>;
  icp?: Record<string, unknown>;
  budget_cents?: number;
  policy?: Record<string, unknown>;
  constitution?: string;
  about?: string;
  knowledge_base?: string;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as UpdateReq | null;
  if (!body?.workspace_id) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });

  const supabase = createServerClient();

  const toolArgs: Record<string, unknown> = {};
  if (body.persona !== undefined) toolArgs.persona = body.persona;
  if (body.icp !== undefined) toolArgs.icp = body.icp;
  if (body.budget_cents !== undefined) toolArgs.budget_cents = body.budget_cents;
  if (body.policy !== undefined) toolArgs.policy = body.policy;

  let event_id: string | null = null;
  if (Object.keys(toolArgs).length > 0) {
    const r = await callTool(
      supabase,
      { workspace_id: body.workspace_id, actor_kind: 'user', actor_id: 'web' },
      'set_workspace_policy',
      toolArgs,
    );
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    event_id = r.event_id;
  }

  // Constitution + About live in their own columns. The set_workspace_policy tool's
  // payload doesn't carry them yet, so we apply via a direct UPDATE.
  const directUpdate: Record<string, unknown> = {};
  if (body.constitution !== undefined) directUpdate.constitution = body.constitution;
  if (body.about !== undefined) directUpdate.about = body.about;
  if (body.knowledge_base !== undefined) directUpdate.knowledge_base = body.knowledge_base;
  if (Object.keys(directUpdate).length > 0) {
    const upd = await supabase.from('workspaces').update(directUpdate).eq('id', body.workspace_id);
    if (upd.error) return NextResponse.json({ error: `update failed: ${upd.error.message}` }, { status: 500 });
  }

  if (Object.keys(toolArgs).length === 0 && Object.keys(directUpdate).length === 0) {
    return NextResponse.json({ error: 'no fields provided' }, { status: 400 });
  }
  return NextResponse.json({ ok: true, event_id });
}
