import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { callTool, listToolDescriptors, TOOL_SCHEMAS, type ToolName } from '@agent-crm/tools';
import type { ActorKind } from '@agent-crm/primitives';

export const runtime = 'nodejs';

// Minimal MCP-over-HTTP. Real MCP uses SSE for streaming; v0 ships request/response JSON-RPC
// (Anthropic's MCP transport supports both; SSE is the upgrade path). External clients can
// list tools and call them with an actor identity passed in the headers.

function getActor(req: Request): { workspace_id: string; actor_kind: ActorKind; actor_id: string } | null {
  const ws = req.headers.get('x-workspace-id');
  const kind = req.headers.get('x-actor-kind') as ActorKind | null;
  const id = req.headers.get('x-actor-id');
  if (!ws || !kind || !id) return null;
  return { workspace_id: ws, actor_kind: kind, actor_id: id };
}

export async function GET() {
  return NextResponse.json({
    name: 'agent-crm',
    version: '0.0.0',
    tools: listToolDescriptors(),
  });
}

export async function POST(req: Request) {
  const actor = getActor(req);
  if (!actor) return NextResponse.json({ error: 'missing actor headers' }, { status: 401 });

  const body = await req.json().catch(() => null) as {
    method?: string;
    params?: { name?: string; arguments?: Record<string, unknown> };
    id?: number | string;
  } | null;
  if (!body) return NextResponse.json({ error: 'invalid body' }, { status: 400 });

  // Minimal JSON-RPC dispatch: tools/list and tools/call.
  if (body.method === 'tools/list') {
    return NextResponse.json({ jsonrpc: '2.0', id: body.id, result: { tools: listToolDescriptors() } });
  }

  if (body.method === 'tools/call') {
    const name = body.params?.name as ToolName | undefined;
    const args = body.params?.arguments ?? {};
    if (!name || !(name in TOOL_SCHEMAS)) {
      return NextResponse.json({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'unknown tool' } }, { status: 400 });
    }
    const supabase = createServerClient();
    const result = await callTool(supabase, actor, name, args);
    return NextResponse.json({ jsonrpc: '2.0', id: body.id, result });
  }

  return NextResponse.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'method not found' } }, { status: 400 });
}
