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
  const actor = { workspace_id: body.workspace_id, actor_kind: 'user' as const, actor_id: 'web' };

  const r = await callTool(supabase, actor, 'decide_gate', { gate_id: body.gate_id, decision: body.decision });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });

  // Post an outcome to the gate's channel so the audit trail closes:
  // signal → ... → draft → gate → outcome (approved / rejected / modified).
  // Without this, the channel goes silent after the gate fires; a later agent
  // re-reading state can't tell whether the human acted.
  try {
    const gate = await supabase
      .from('gates')
      .select('channel_post_id, policy, requested_by_agent, channel_posts:channel_post_id(channel_id)')
      .eq('id', body.gate_id)
      .maybeSingle();
    const channelId = (gate.data?.channel_posts as { channel_id?: string } | undefined)?.channel_id;
    if (channelId) {
      const verdict = body.decision === 'approve' ? 'approved' : body.decision === 'reject' ? 'rejected' : 'modified';
      const summary = `Gate ${verdict} by web (policy=${gate.data?.policy ?? '?'}, requested by ${gate.data?.requested_by_agent ?? '?'}).`;
      await callTool(supabase, actor, 'post_to_channel', {
        channel_id: channelId, kind: 'outcome', body: summary,
        parent_post_id: gate.data?.channel_post_id ?? undefined,
      });
    }
  } catch {
    // Non-fatal: gate was decided successfully even if outcome post failed.
  }

  return NextResponse.json({ ok: true, event_id: r.event_id });
}
