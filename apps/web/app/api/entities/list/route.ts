import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspace_id = url.searchParams.get('workspace_id');
  const kind = url.searchParams.get('kind') ?? 'account';
  if (!workspace_id) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });

  const supabase = createServerClient();
  const { data, error } = await supabase
    .from('entities')
    .select('id, name, kind, attributes')
    .eq('workspace_id', workspace_id)
    .eq('kind', kind)
    .order('name');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ entities: data ?? [] });
}
