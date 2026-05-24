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
  const { data } = await sb.from('workspace_invitations')
    .select('id, email, role, expires_at, accepted_at, created_at')
    .eq('workspace_id', workspace_id)
    .is('accepted_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false });

  return NextResponse.json({ invitations: data ?? [] });
}
