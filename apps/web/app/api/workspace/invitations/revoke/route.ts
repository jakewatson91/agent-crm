import { NextResponse } from 'next/server';
import { getUser, getWorkspaceRole, hasRole } from '../../../../_lib/auth';
import { createServiceClient } from '../../../../_lib/supabase-server';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { id?: string } | null;
  if (!body?.id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const user = await getUser();
  if (!user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const sb = createServiceClient();
  const { data: inv } = await sb.from('workspace_invitations')
    .select('workspace_id').eq('id', body.id).maybeSingle();
  if (!inv) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const role = await getWorkspaceRole(user.id, inv.workspace_id);
  if (!hasRole(role, 'admin')) {
    return NextResponse.json({ error: 'admin or owner required' }, { status: 403 });
  }

  const { error } = await sb.from('workspace_invitations').delete().eq('id', body.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
