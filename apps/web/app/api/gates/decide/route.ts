import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { callTool } from '@agent-crm/tools';
import { sendEmail } from '../../_lib/send_email';

export const runtime = 'nodejs';

interface DecideReq {
  workspace_id: string;
  gate_id: string;
  decision: 'approve' | 'reject' | 'modify';
  // Optional overrides used when the gate is an outreach draft and the user
  // tweaked the message before clicking accept.
  edited_subject?: string;
  edited_body?: string;
  reason?: string;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as DecideReq | null;
  if (!body?.workspace_id || !body?.gate_id || !body?.decision) {
    return NextResponse.json({ error: 'workspace_id, gate_id, decision required' }, { status: 400 });
  }
  const supabase = createServerClient();
  const actor = { workspace_id: body.workspace_id, actor_kind: 'user' as const, actor_id: 'web' };

  // Load gate details up front so we know whether this is an outreach-send
  // approval (special path) or any other gate (legacy path).
  const gateRes = await supabase
    .from('gates')
    .select('policy, condition, channel_post_id, requested_by_agent, channel_posts:channel_post_id(channel_id)')
    .eq('id', body.gate_id)
    .maybeSingle();
  if (gateRes.error || !gateRes.data) {
    return NextResponse.json({ error: `gate not found: ${gateRes.error?.message ?? 'unknown'}` }, { status: 404 });
  }
  const gate = gateRes.data as {
    policy: string;
    condition: Record<string, unknown> | null;
    channel_post_id: string | null;
    requested_by_agent: string | null;
    channel_posts: { channel_id?: string } | null;
  };
  const channelId = gate.channel_posts?.channel_id ?? null;
  const isOutreachApprove = gate.policy === 'outreach_send' && body.decision === 'approve';

  let sendInfo: { effective_to?: string; override_active?: boolean; message_id?: string; intended_to?: string | null; edited?: boolean } | null = null;

  // On outreach approve, send the email BEFORE updating the gate. If the send
  // fails, leave the gate undecided so the user can retry.
  if (isOutreachApprove) {
    const cond = (gate.condition ?? {}) as { to_email?: string | null; subject?: string; body?: string; entity_id?: string };
    const subject = body.edited_subject ?? cond.subject ?? '';
    const text = body.edited_body ?? cond.body ?? '';
    const intended_to = cond.to_email ?? null;
    if (!text) {
      return NextResponse.json({ error: 'gate condition has no body to send' }, { status: 400 });
    }
    const sendRes = await sendEmail({ intended_to, subject, body: text });
    if (!sendRes.ok) {
      return NextResponse.json({ error: `send failed: ${sendRes.error}` }, { status: 502 });
    }
    sendInfo = {
      effective_to: sendRes.effective_to,
      override_active: sendRes.override_active,
      message_id: sendRes.message_id,
      intended_to,
      edited: body.edited_subject !== undefined || body.edited_body !== undefined,
    };
  }

  // Update the gate row.
  const r = await callTool(supabase, actor, 'decide_gate', { gate_id: body.gate_id, decision: body.decision });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });

  // Audit + state-change side effects per decision.
  try {
    const entity_id = (gate.condition as { entity_id?: string } | null)?.entity_id ?? null;

    if (isOutreachApprove && channelId && sendInfo) {
      const overrideNote = sendInfo.override_active
        ? ` (override active; intended recipient: ${sendInfo.intended_to ?? 'no contact resolved'})`
        : '';
      const editedNote = sendInfo.edited ? ' Edited before send.' : '';
      const auditBody = `Sent → ${sendInfo.effective_to}${overrideNote}.${editedNote} message_id=${sendInfo.message_id ?? '?'}`;
      await callTool(supabase, actor, 'post_to_channel', {
        channel_id: channelId, kind: 'system', body: auditBody,
        parent_post_id: gate.channel_post_id ?? undefined,
      });
      if (entity_id) {
        await callTool(supabase, actor, 'assert_fact', {
          subject_entity: entity_id,
          predicate: 'last_outreach_at',
          object_text: new Date().toISOString(),
          confidence: 1.0,
        });
      }
    } else if (channelId) {
      // Non-outreach OR reject path: original outcome post (preserved).
      const verdict = body.decision === 'approve' ? 'approved' : body.decision === 'reject' ? 'rejected' : 'modified';
      const reasonPart = body.reason ? ` — ${body.reason}` : '';
      const summary = `Gate ${verdict} by web (policy=${gate.policy ?? '?'}, requested by ${gate.requested_by_agent ?? '?'})${reasonPart}.`;
      await callTool(supabase, actor, 'post_to_channel', {
        channel_id: channelId, kind: 'outcome', body: summary,
        parent_post_id: gate.channel_post_id ?? undefined,
      });
    }

    // Rejection state on the entity (only meaningful for outreach rejections).
    if (gate.policy === 'outreach_send' && body.decision === 'reject' && entity_id) {
      await callTool(supabase, actor, 'assert_fact', {
        subject_entity: entity_id,
        predicate: 'outreach_rejected_at',
        object_text: new Date().toISOString(),
        confidence: 1.0,
      });
    }
  } catch {
    // Non-fatal: gate was decided + (if outreach) email was sent.
  }

  return NextResponse.json({
    ok: true,
    event_id: r.event_id,
    sent: sendInfo ?? null,
  });
}
