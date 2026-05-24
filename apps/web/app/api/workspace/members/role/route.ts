import { NextResponse } from 'next/server';
import { getUser, getWorkspaceRole, type WorkspaceRole } from '../../../../_lib/auth';
import { createServiceClient } from '../../../../_lib/supabase-server';

export const runtime = 'nodejs';

interface RoleReq {
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
}

const ALLOWED: WorkspaceRole[] = ['owner', 'admin', 'member', 'viewer'];

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as RoleReq | null;
  if (!body?.workspace_id || !body?.user_id || !body?.role) {
    return NextResponse.json({ error: 'workspace_id, user_id, role required' }, { status: 400 });
  }
  if (!ALLOWED.includes(body.role)) {
    return NextResponse.json({ error: 'invalid role' }, { status: 400 });
  }

  const user = await getUser();
  if (!user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const callerRole = await getWorkspaceRole(user.id, body.workspace_id);
  if (callerRole !== 'owner') {
    return NextResponse.json({ error: 'owner required to change roles' }, { status: 403 });
  }

  const sb = createServiceClient();

  // If we're demoting an owner, ensure at least one owner remains.
  if (body.role !== 'owner') {
    const { data: target } = await sb.from('workspace_members')
      .select('role').eq('workspace_id', body.workspace_id).eq('user_id', body.user_id).maybeSingle();
    if (target?.role === 'owner') {
      const { count } = await sb.from('workspace_members')
        .select('user_id', { count: 'exact', head: true })
        .eq('workspace_id', body.workspace_id).eq('role', 'owner');
      if ((count ?? 0) <= 1) {
        return NextResponse.json({ error: 'cannot demote the last owner' }, { status: 400 });
      }
    }
  }

  const { error } = await sb.from('workspace_members')
    .update({ role: body.role })
    .eq('workspace_id', body.workspace_id)
    .eq('user_id', body.user_id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
