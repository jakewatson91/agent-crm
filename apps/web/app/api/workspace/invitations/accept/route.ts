/**
 * Accept an invitation by token. Idempotent: re-accepting an already-accepted
 * invitation by the same user is a no-op. Adds the user to workspace_members
 * with the role from the invitation.
 *
 * The invite page (apps/web/app/invite/[token]/page.tsx) calls this after
 * ensuring the user is signed in. Token doubles as the secret; we don't expose
 * a public token-based read policy.
 */
import { NextResponse } from 'next/server';
import { getUser } from '../../../../_lib/auth';
import { createServiceClient } from '../../../../_lib/supabase-server';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { token?: string } | null;
  if (!body?.token) return NextResponse.json({ error: 'token required' }, { status: 400 });

  const user = await getUser();
  if (!user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const sb = createServiceClient();
  const { data: inv } = await sb.from('workspace_invitations')
    .select('id, workspace_id, email, role, expires_at, accepted_at')
    .eq('token', body.token)
    .maybeSingle();
  if (!inv) return NextResponse.json({ error: 'invitation not found' }, { status: 404 });
  if (new Date(inv.expires_at).getTime() < Date.now()) {
    return NextResponse.json({ error: 'invitation expired' }, { status: 410 });
  }

  // Email match check is informational, not a hard gate — the signed-in user
  // may have a different alias than the invited address.
  const emailMismatch = (user.email ?? '').toLowerCase() !== (inv.email ?? '').toLowerCase();

  if (inv.accepted_at) {
    return NextResponse.json({ ok: true, workspace_id: inv.workspace_id, already_accepted: true, email_mismatch: emailMismatch });
  }

  // Upsert membership.
  const { error: memErr } = await sb.from('workspace_members')
    .upsert({ workspace_id: inv.workspace_id, user_id: user.id, role: inv.role });
  if (memErr) return NextResponse.json({ error: memErr.message }, { status: 500 });

  await sb.from('workspace_invitations')
    .update({ accepted_at: new Date().toISOString(), accepted_by: user.id })
    .eq('id', inv.id);

  return NextResponse.json({ ok: true, workspace_id: inv.workspace_id, email_mismatch: emailMismatch });
}
