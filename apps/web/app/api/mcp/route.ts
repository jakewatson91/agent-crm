/**
 * MCP-over-HTTP. Two auth paths:
 *   1. Production: Authorization: Bearer acrm_<secret> → workspace + actor
 *      derived from workspace_api_keys.
 *   2. Dev only (NODE_ENV !== 'production'): legacy x-workspace-id +
 *      x-actor-kind + x-actor-id headers. Useful for local scripts and
 *      smoke tests without provisioning a key.
 */
import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { createServerClient } from '@agent-crm/db';
import { callTool, listToolDescriptors, TOOL_SCHEMAS, type ToolName } from '@agent-crm/tools';
import type { ActorKind } from '@agent-crm/primitives';

export const runtime = 'nodejs';

interface ResolvedActor {
  workspace_id: string;
  actor_kind: ActorKind;
  actor_id: string;
}

async function resolveActor(req: Request): Promise<ResolvedActor | null> {
  const auth = req.headers.get('authorization') ?? '';
  const m = auth.match(/^Bearer\s+(acrm_[A-Za-z0-9_-]+)$/);
  if (m) {
    const secret = m[1]!;
    const key_hash = createHash('sha256').update(secret).digest('hex');
    const sb = createServerClient();
    const { data } = await sb.from('workspace_api_keys')
      .select('id, workspace_id, created_by, revoked_at')
      .eq('key_hash', key_hash)
      .maybeSingle();
    if (!data || data.revoked_at) return null;
    // Touch last_used_at; fire-and-forget.
    sb.from('workspace_api_keys').update({ last_used_at: new Date().toISOString() })
      .eq('id', data.id).then(() => undefined);
    return {
      workspace_id: data.workspace_id,
      actor_kind: 'user',
      actor_id: data.created_by,
    };
  }

  if (process.env.NODE_ENV !== 'production') {
    const ws = req.headers.get('x-workspace-id');
    const kind = req.headers.get('x-actor-kind') as ActorKind | null;
    const id = req.headers.get('x-actor-id');
    if (ws && kind && id) return { workspace_id: ws, actor_kind: kind, actor_id: id };
  }

  return null;
}

export async function GET() {
  return NextResponse.json({
    name: 'agent-crm',
    version: '0.0.0',
    tools: listToolDescriptors(),
  });
}

export async function POST(req: Request) {
  const actor = await resolveActor(req);
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => null) as {
    method?: string;
    params?: { name?: string; arguments?: Record<string, unknown> };
    id?: number | string;
  } | null;
  if (!body) return NextResponse.json({ error: 'invalid body' }, { status: 400 });

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
