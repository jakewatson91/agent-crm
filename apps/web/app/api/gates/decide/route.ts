import { NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { createServerClient } from '@agent-crm/db';
import { callTool, getPolicy, setOutreachStage, diffDraftBody } from '@agent-crm/tools';
import { sendEmail } from '../../_lib/send_email';
import { sanitizeEmailHtml, htmlToPlainText } from '../../_lib/html_email';
import { getUser } from '../../../_lib/auth';

export const runtime = 'nodejs';

interface DecideReq {
  workspace_id: string;
  gate_id: string;
  decision: 'approve' | 'reject' | 'modify';
  // Optional overrides used when the gate is an outreach draft and the user
  // tweaked the message before clicking accept. edited_html is the rich-text
  // body from the WYSIWYG editor; edited_body stays for plain-text edits.
  edited_subject?: string;
  edited_body?: string;
  edited_html?: string;
  reason?: string;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as DecideReq | null;
  if (!body?.workspace_id || !body?.gate_id || !body?.decision) {
    return NextResponse.json({ error: 'workspace_id, gate_id, decision required' }, { status: 400 });
  }
  const supabase = createServerClient();
  // Who is actually clicking. This used to be the literal string 'web' for every
  // decision, and gates.decided_by was never written at all — so the audit trail
  // recorded which agent REQUESTED an irreversible outbound send but not which
  // human let it out. Middleware has already verified the session, so the cookie
  // read here is a lookup, not a trust decision; if it somehow yields nothing we
  // fall back to 'web' rather than block a legitimate approval.
  // The uuid specifically, not the email: record_event only copies actor_id into
  // gates.decided_by when it matches a uuid (see migration 0041), so a friendly
  // string lands as null — which is exactly what every decision so far did. The
  // email rides along in the resolution instead, so the audit reads without a
  // join.
  const user = await getUser().catch(() => null);
  const actor = { workspace_id: body.workspace_id, actor_kind: 'user' as const, actor_id: user?.id ?? 'web' };

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
  const channelType = ((gate.condition ?? {}) as { channel_type?: string }).channel_type ?? 'email';

  // Unified resolution payload: a free-text note (any decision type) plus,
  // on an edited approval, what actually changed. Persisted on the gate and
  // surfaced to future drafts on similar accounts via pastOutcomes.
  const note = body.reason?.trim() || undefined;
  let resolution: Record<string, unknown> = {
    ...(note ? { note } : {}),
    // Readable alongside gates.decided_by, which stores only the uuid.
    ...(user?.email ? { decided_by_email: user.email } : {}),
  };

  let sendInfo: { effective_to?: string; override_active?: boolean; message_id?: string; intended_to?: string | null; edited?: boolean } | null = null;

  // On outreach approve, resolve what the final message IS (original or edited)
  // before touching the gate. Email then sends it; LinkedIn records it for the
  // manual copy-to-send. Edits are persisted either way — an edited LinkedIn
  // approval used to fall through the email-only branch and silently drop the
  // edited text.
  let finalText: string | null = null;
  if (isOutreachApprove) {
    const cond = (gate.condition ?? {}) as { to_email?: string | null; subject?: string; body?: string; entity_id?: string };
    const subject = body.edited_subject ?? cond.subject ?? '';
    const intended_to = cond.to_email ?? null;
    // Rich-text edit: sanitize the HTML and derive a plain-text fallback from it
    // so both parts of the email agree. Plain-text edit or no edit: text only.
    const html = body.edited_html ? sanitizeEmailHtml(body.edited_html) : null;
    const text = html ? htmlToPlainText(html) : (body.edited_body ?? cond.body ?? '');
    finalText = text;
    const edited = body.edited_subject !== undefined || body.edited_body !== undefined || body.edited_html !== undefined;
    if (edited) {
      const originalSubject = cond.subject ?? '';
      const originalBody = cond.body ?? '';
      const subjectDiff = originalSubject !== subject ? { from: originalSubject, to: subject } : undefined;
      const bodyDiff = diffDraftBody(originalBody, text);
      resolution = {
        ...resolution,
        edited: true,
        ...(subjectDiff ? { subject_diff: subjectDiff } : {}),
        ...(bodyDiff.length ? { body_diff: bodyDiff } : {}),
        // The full final text, not just the diff, so the feed and any later
        // audit can show exactly what the operator approved to send.
        ...(channelType === 'linkedin' ? { final_body: text } : {}),
      };
    }

    // Email: send BEFORE updating the gate. If the send fails, leave the gate
    // undecided so the user can retry. LinkedIn: no automated send.
    if (channelType !== 'linkedin') {
      if (!text) {
        return NextResponse.json({ error: 'gate condition has no body to send' }, { status: 400 });
      }
      const sendRes = await sendEmail({ supabase, workspace_id: body.workspace_id, intended_to, subject, body: text, html: html ?? undefined });
      if (!sendRes.ok) {
        return NextResponse.json({ error: `send failed: ${sendRes.error}` }, { status: 502 });
      }
      sendInfo = {
        effective_to: sendRes.effective_to,
        override_active: sendRes.override_active,
        message_id: sendRes.message_id,
        intended_to,
        edited,
      };
    }
  }

  // Update the gate row.
  const r = await callTool(supabase, actor, 'decide_gate', { gate_id: body.gate_id, decision: body.decision, resolution });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });

  // The feed API caches per-workspace lists for 60s under this tag; without
  // invalidation a decided draft keeps showing as needs-approval until the
  // window expires, even across a full page reload.
  revalidateTag('feed');

  // Audit + state-change side effects per decision.
  try {
    const entity_id = (gate.condition as { entity_id?: string } | null)?.entity_id ?? null;

    if (isOutreachApprove && channelId) {
      // Audit note varies by channel type, but cooldown + stage are the same.
      if (channelType === 'linkedin') {
        // When the operator edited before approving, the parent draft post no
        // longer shows the real message — include the final text here so the
        // feed always has the exact thing to paste.
        const editedLi = resolution.edited === true && finalText;
        await callTool(supabase, actor, 'post_to_channel', {
          channel_id: channelId, kind: 'system',
          body: editedLi
            ? `LinkedIn message approved (edited) — send manually via LinkedIn:\n\n${finalText}`
            : 'LinkedIn message approved — send manually via LinkedIn.',
          parent_post_id: gate.channel_post_id ?? undefined,
        });
      } else if (sendInfo) {
        const overrideNote = sendInfo.override_active
          ? ` (override active; intended recipient: ${sendInfo.intended_to ?? 'no contact resolved'})`
          : '';
        const editedNote = sendInfo.edited ? ' Edited before send.' : '';
        const auditBody = `Sent → ${sendInfo.effective_to}${overrideNote}.${editedNote} message_id=${sendInfo.message_id ?? '?'}`;
        await callTool(supabase, actor, 'post_to_channel', {
          channel_id: channelId, kind: 'system', body: auditBody,
          parent_post_id: gate.channel_post_id ?? undefined,
        });
      }
      if (entity_id) {
        await callTool(supabase, actor, 'assert_fact', {
          subject_entity: entity_id,
          predicate: 'last_outreach_at',
          object_text: new Date().toISOString(),
          confidence: 1.0,
        });
        // Post-send cooldown: block re-drafting for policy.drafter.cooldown_days.
        // action_selector reads outreach_cooldown_until before any other gate.
        const pol = await getPolicy(supabase, body.workspace_id);
        const cooldownDays = pol.drafter?.cooldown_days ?? 14;
        const until = new Date(Date.now() + cooldownDays * 86400_000).toISOString();
        await callTool(supabase, actor, 'assert_fact', {
          subject_entity: entity_id,
          predicate: 'outreach_cooldown_until',
          object_text: until,
          confidence: 1.0,
        });
        await setOutreachStage(supabase, actor, entity_id, 'contacted');
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
