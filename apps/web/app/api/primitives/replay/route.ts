import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as { workspace_id?: string; ts?: string } | null;
  if (!body?.workspace_id || !body?.ts) {
    return NextResponse.json({ error: 'workspace_id and ts required' }, { status: 400 });
  }
  const supabase = createServerClient();
  const { data, error } = await supabase.rpc('replay_to', {
    p_workspace_id: body.workspace_id,
    p_ts: body.ts,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
