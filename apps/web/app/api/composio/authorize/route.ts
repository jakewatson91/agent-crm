import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { authorize, getToolkit, composioUserId } from '@agent-crm/composio';

export const runtime = 'nodejs';

/**
 * POST /api/composio/authorize
 *
 * Body: { workspace_id, toolkit_slug }
 *
 * Starts an OAuth handoff for a toolkit. The caller (UI) opens the
 * returned `redirect_url` in a new tab; the user completes OAuth at
 * Composio's hosted page and is redirected back. The connection row
 * stays in `status='initiated'` until the UI calls `/connections/[id]/refresh`
 * (or any caller polls) which checks Composio for ACTIVE.
 *
 * Idempotent: re-authorizing an existing toolkit reuses the row and
 * updates `connect_url`. Disconnect-then-reconnect is handled by the
 * delete endpoint resetting the row.
 */
export async function POST(req: Request) {
  let body: { workspace_id?: string; toolkit_slug?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json body' }, { status: 400 });
  }
  const workspace_id = body.workspace_id?.trim();
  const toolkit_slug = body.toolkit_slug?.trim().toLowerCase();
  if (!workspace_id || !toolkit_slug) {
    return NextResponse.json({ error: 'workspace_id and toolkit_slug required' }, { status: 400 });
  }
  if (!getToolkit(toolkit_slug)) {
    return NextResponse.json({ error: `unknown toolkit: ${toolkit_slug}` }, { status: 400 });
  }

  let result;
  try {
    result = await authorize(workspace_id, toolkit_slug);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `composio authorize failed: ${msg}` }, { status: 502 });
  }

  const supabase = createServerClient();
  const { error } = await supabase
    .from('composio_connections')
    .upsert(
      {
        workspace_id,
        toolkit_slug,
        composio_connection_id: result.connection_id,
        composio_user_id: composioUserId(workspace_id),
        status: 'initiated',
        connect_url: result.redirect_url,
        last_error: null,
      },
      { onConflict: 'workspace_id,toolkit_slug' },
    );
  if (error) {
    return NextResponse.json({ error: `db: ${error.message}` }, { status: 500 });
  }

  return NextResponse.json({
    connection_id: result.connection_id,
    redirect_url: result.redirect_url,
  });
}
