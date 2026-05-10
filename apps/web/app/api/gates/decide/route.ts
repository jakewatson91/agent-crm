import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { callTool } from '@agent-crm/tools';

export const runtime = 'nodejs';

interface DecideReq {
  workspace_id: string;
  gate_id: string;
  decision: 'approve' | 'reject' | 'modify';
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as DecideReq | null;
  if (!body?.workspace_id || !body?.gate_id || !body?.decision) {
    return NextResponse.json({ error: 'workspace_id, gate_id, decision required' }, { status: 400 });
  }
  const supabase = createServerClient();
  const r = await callTool(
    supabase,
    { workspace_id: body.workspace_id, actor_kind: 'user', actor_id: 'web' },
    'decide_gate',
    { gate_id: body.gate_id, decision: body.decision },
  );
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  return NextResponse.json({ ok: true, event_id: r.event_id });
}
