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
  const { data: key } = await sb.from('workspace_api_keys')
    .select('workspace_id, revoked_at').eq('id', body.id).maybeSingle();
  if (!key) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const role = await getWorkspaceRole(user.id, key.workspace_id);
  if (!hasRole(role, 'admin')) {
    return NextResponse.json({ error: 'admin or owner required' }, { status: 403 });
  }

  if (key.revoked_at) return NextResponse.json({ ok: true, already_revoked: true });

  const { error } = await sb.from('workspace_api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', body.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
