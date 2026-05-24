import { NextResponse } from 'next/server';
import { getUser, getWorkspaceRole } from '../../../../_lib/auth';
import { createServiceClient } from '../../../../_lib/supabase-server';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspace_id = url.searchParams.get('workspace_id');
  if (!workspace_id) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });

  const user = await getUser();
  if (!user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const role = await getWorkspaceRole(user.id, workspace_id);
  if (!role) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const sb = createServiceClient();
  const { data: members } = await sb.from('workspace_members')
    .select('user_id, role, created_at')
    .eq('workspace_id', workspace_id);

  // Pull emails from auth.users for each member. service_role can read this view.
  const userIds = (members ?? []).map((m) => m.user_id);
  const emails: Record<string, string> = {};
  if (userIds.length > 0) {
    const { data: users } = await sb.auth.admin.listUsers({ perPage: 200 });
    for (const u of users?.users ?? []) {
      if (userIds.includes(u.id)) emails[u.id] = u.email ?? '';
    }
  }

  const enriched = (members ?? []).map((m) => ({
    user_id: m.user_id,
    role: m.role as 'owner' | 'admin' | 'member' | 'viewer',
    email: emails[m.user_id] ?? '',
    created_at: m.created_at,
    is_self: m.user_id === user.id,
  }));

  return NextResponse.json({ members: enriched, viewer_role: role });
}
