import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { callTool, type ToolName, TOOL_SCHEMAS } from '@agent-crm/tools';
import type { ActorKind } from '@agent-crm/primitives';

export const runtime = 'nodejs';

interface ActReq {
  workspace_id: string;
  actor_kind: ActorKind;
  actor_id: string;
  tool: ToolName;
  args: Record<string, unknown>;
  prompt_hash?: string;
  parent_event_id?: string;
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as ActReq | null;
  if (!body || !(body.tool in TOOL_SCHEMAS)) {
    return NextResponse.json({ error: 'invalid request' }, { status: 400 });
  }
  const supabase = createServerClient();
  const result = await callTool(
    supabase,
    { workspace_id: body.workspace_id, actor_kind: body.actor_kind, actor_id: body.actor_id },
    body.tool,
    body.args,
    { prompt_hash: body.prompt_hash, parent_event_id: body.parent_event_id },
  );
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
