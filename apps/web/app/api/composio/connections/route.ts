import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';

export const runtime = 'nodejs';

/**
 * GET /api/composio/connections?workspace_id=X
 *
 * Lists all Composio connections for a workspace, joined with the curated
 * toolkit metadata. Status reflects the last refresh against Composio.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspace_id = url.searchParams.get('workspace_id');
  if (!workspace_id) {
    return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });
  }
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from('composio_connections')
    .select('id, toolkit_slug, composio_connection_id, status, connect_url, profile, last_error, created_at, updated_at')
    .eq('workspace_id', workspace_id)
    .order('created_at', { ascending: false });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ connections: data ?? [] });
}
