/**
 * MCP-over-HTTP. Two auth paths:
 *   1. Production: Authorization: Bearer acrm_<secret> → workspace + actor
 *      derived from workspace_api_keys.
 *   2. Dev only (NODE_ENV !== 'production'): legacy x-workspace-id +
 *      x-actor-kind + x-actor-id headers. Useful for local scripts and
 *      smoke tests without provisioning a key.
 */
import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { callTool, listToolDescriptors, TOOL_SCHEMAS, type ToolName, type ToolDeps } from '@agent-crm/tools';
import { resolveActor } from '../_lib/resolve_api_key';
import { makeRequestDraft } from '../../_lib/request_draft';

export const runtime = 'nodejs';

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
    // Capabilities @agent-crm/tools cannot reach on its own. The event bus lives
    // in @agent-crm/inngest, which imports tools — so tools never imports it
    // back, and this layer (which already depends on both) passes the function
    // down instead. Imported lazily for the same reason /api/research/run-now
    // does it: keeps the inngest client off the module graph of every request
    // that never touches it.
    const deps = {
      async requestResearch(event: Parameters<NonNullable<ToolDeps['requestResearch']>>[0]) {
        const { inngest } = await import('@agent-crm/inngest');
        return inngest.send({ name: 'research.requested', data: event });
      },
      requestDraft: makeRequestDraft(supabase),
    } satisfies ToolDeps;
    const result = await callTool(supabase, actor, name, args, undefined, deps);
    return NextResponse.json({ jsonrpc: '2.0', id: body.id, result });
  }

  return NextResponse.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'method not found' } }, { status: 400 });
}
