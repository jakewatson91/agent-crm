import { NextResponse } from 'next/server';
import { getUser, getWorkspaceRole, hasRole } from '../../../../_lib/auth';
import { createServiceClient } from '../../../../_lib/supabase-server';

export const runtime = 'nodejs';

interface RemoveReq {
  workspace_id: string;
  user_id: string;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as RemoveReq | null;
  if (!body?.workspace_id || !body?.user_id) {
    return NextResponse.json({ error: 'workspace_id and user_id required' }, { status: 400 });
  }

  const user = await getUser();
  if (!user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const role = await getWorkspaceRole(user.id, body.workspace_id);
  if (!hasRole(role, 'admin')) {
    return NextResponse.json({ error: 'admin or owner required' }, { status: 403 });
  }

  const sb = createServiceClient();

  // Don't allow removing the last owner.
  const { data: target } = await sb.from('workspace_members')
    .select('role').eq('workspace_id', body.workspace_id).eq('user_id', body.user_id).maybeSingle();
  if (!target) return NextResponse.json({ error: 'not a member' }, { status: 404 });
  if (target.role === 'owner') {
    const { count } = await sb.from('workspace_members')
      .select('user_id', { count: 'exact', head: true })
      .eq('workspace_id', body.workspace_id).eq('role', 'owner');
    if ((count ?? 0) <= 1) {
      return NextResponse.json({ error: 'cannot remove the last owner' }, { status: 400 });
    }
    if (role !== 'owner') {
      return NextResponse.json({ error: 'only an owner can remove another owner' }, { status: 403 });
    }
  }

  const { error } = await sb.from('workspace_members')
    .delete()
    .eq('workspace_id', body.workspace_id)
    .eq('user_id', body.user_id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
