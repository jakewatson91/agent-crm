import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { getUser, getWorkspaceRole, hasRole } from '../../../../_lib/auth';
import { createServiceClient } from '../../../../_lib/supabase-server';
import { sendEmail } from '../../../_lib/send_email';

export const runtime = 'nodejs';

interface InviteReq {
  workspace_id: string;
  email: string;
  role: 'admin' | 'member' | 'viewer';
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as InviteReq | null;
  if (!body?.workspace_id || !body?.email || !body?.role) {
    return NextResponse.json({ error: 'workspace_id, email, role required' }, { status: 400 });
  }

  const user = await getUser();
  if (!user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const role = await getWorkspaceRole(user.id, body.workspace_id);
  if (!hasRole(role, 'admin')) {
    return NextResponse.json({ error: 'admin or owner required' }, { status: 403 });
  }

  const token = randomBytes(24).toString('base64url');
  const sb = createServiceClient();

  const { data, error } = await sb.from('workspace_invitations').insert({
    workspace_id: body.workspace_id,
    email: body.email.toLowerCase().trim(),
    role: body.role,
    token,
    invited_by: user.id,
  }).select('id, email, role, expires_at, created_at').single();
  if (error || !data) return NextResponse.json({ error: error?.message ?? 'insert failed' }, { status: 500 });

  // Determine site URL for the accept link.
  const proto = req.headers.get('x-forwarded-proto') ?? 'https';
  const host = req.headers.get('host') ?? 'localhost:3000';
  const acceptUrl = `${proto}://${host}/invite/${token}`;

  // Best-effort email; if Resend isn't configured, still return the invitation
  // with the URL so the inviter can share it manually.
  const { data: ws } = await sb.from('workspaces').select('name').eq('id', body.workspace_id).single();
  const wsName = ws?.name ?? 'agent-crm';
  const sent = await sendEmail({
    supabase: sb,
    workspace_id: body.workspace_id,
    intended_to: body.email,
    subject: `You're invited to ${wsName} on agent-crm`,
    body: `You've been invited to join ${wsName} as ${body.role}.\n\nAccept here: ${acceptUrl}\n\nThis link expires in 7 days.`,
  });

  return NextResponse.json({
    ok: true,
    invitation: data,
    accept_url: acceptUrl,
    email_sent: sent.ok,
    email_error: sent.ok ? undefined : sent.error,
  });
}
