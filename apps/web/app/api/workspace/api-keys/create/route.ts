/**
 * Issue a new API key for a workspace. Returns the full secret exactly once;
 * after this response, only the prefix is recoverable.
 *
 * Secret format: acrm_<43 base64url chars from 32 random bytes>. SHA-256 of
 * the secret is stored.
 */
import { NextResponse } from 'next/server';
import { createHash, randomBytes } from 'node:crypto';
import { getUser, getWorkspaceRole, hasRole } from '../../../../_lib/auth';
import { createServiceClient } from '../../../../_lib/supabase-server';

export const runtime = 'nodejs';

interface CreateReq {
  workspace_id: string;
  name: string;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as CreateReq | null;
  if (!body?.workspace_id || !body?.name) {
    return NextResponse.json({ error: 'workspace_id and name required' }, { status: 400 });
  }

  const user = await getUser();
  if (!user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const role = await getWorkspaceRole(user.id, body.workspace_id);
  if (!hasRole(role, 'admin')) {
    return NextResponse.json({ error: 'admin or owner required' }, { status: 403 });
  }

  const secret = `acrm_${randomBytes(32).toString('base64url')}`;
  const key_hash = createHash('sha256').update(secret).digest('hex');
  const prefix = secret.slice(0, 12);

  const sb = createServiceClient();
  const { data, error } = await sb.from('workspace_api_keys').insert({
    workspace_id: body.workspace_id,
    name: body.name,
    key_hash,
    prefix,
    created_by: user.id,
  }).select('id, name, prefix, created_at').single();
  if (error || !data) return NextResponse.json({ error: error?.message ?? 'insert failed' }, { status: 500 });

  return NextResponse.json({ ok: true, key: secret, ...data });
}
