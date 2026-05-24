import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { fetchUserProfile, getConnectionStatus } from '@agent-crm/composio';

export const runtime = 'nodejs';

/**
 * POST /api/composio/connections/[id]/refresh
 *
 * Polls Composio for the current status of a connection and updates the
 * local row. Used by the settings UI while OAuth is in flight, and on
 * any "is this still working?" check.
 *
 * Side effect: when status transitions to ACTIVE for the first time,
 * we pull the user profile and stash it on the row so the UI can show
 * which account ("user@company.com") is wired up.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const supabase = createServerClient();
  const { data: row, error: readErr } = await supabase
    .from('composio_connections')
    .select('id, workspace_id, toolkit_slug, composio_connection_id, status, profile')
    .eq('id', id)
    .single();
  if (readErr || !row) {
    return NextResponse.json({ error: readErr?.message ?? 'not found' }, { status: 404 });
  }
  if (!row.composio_connection_id) {
    return NextResponse.json({ error: 'connection has no composio id yet' }, { status: 409 });
  }

  let status: string;
  try {
    const s = await getConnectionStatus(row.composio_connection_id);
    status = s.status;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await supabase
      .from('composio_connections')
      .update({ last_error: msg })
      .eq('id', id);
    return NextResponse.json({ error: `composio status failed: ${msg}` }, { status: 502 });
  }

  const localStatus = status.toLowerCase();
  let profile = row.profile ?? {};
  const becameActive = localStatus === 'active' && row.status !== 'active';
  if (becameActive) {
    try {
      const p = await fetchUserProfile(row.workspace_id, row.toolkit_slug);
      if (p) profile = p;
    } catch (e) {
      console.warn('[composio] profile fetch failed:', e instanceof Error ? e.message : e);
    }
  }

  const { error: updErr } = await supabase
    .from('composio_connections')
    .update({ status: localStatus, profile, last_error: null })
    .eq('id', id);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  return NextResponse.json({ status: localStatus, profile });
}
