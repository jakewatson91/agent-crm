import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { entityIdsOfType } from '@agent-crm/tools';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspace_id = url.searchParams.get('workspace_id');
  const kind = url.searchParams.get('kind') ?? 'account';
  if (!workspace_id) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });

  const supabase = createServerClient();
  const ids = await entityIdsOfType(supabase, workspace_id, kind);
  if (ids.length === 0) return NextResponse.json({ entities: [] });
  const { data, error } = await supabase
    .from('entities')
    .select('id, name, attributes')
    .in('id', ids)
    .order('name');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const rows = ((data ?? []) as Array<{ id: string; name: string; attributes: Record<string, unknown> }>)
    .map((r) => ({ ...r, kind }));
  return NextResponse.json({ entities: rows });
}
