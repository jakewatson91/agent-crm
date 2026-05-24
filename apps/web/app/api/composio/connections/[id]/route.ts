import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { disconnect } from '@agent-crm/composio';

export const runtime = 'nodejs';

/**
 * DELETE /api/composio/connections/[id]
 *
 * Disconnects a Composio connection (revokes at Composio + deletes the row).
 * `id` is the local row id. The row carries the Composio connection id we
 * need to pass to the SDK.
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const supabase = createServerClient();
  const { data: row, error: readErr } = await supabase
    .from('composio_connections')
    .select('id, composio_connection_id')
    .eq('id', id)
    .single();
  if (readErr || !row) {
    return NextResponse.json({ error: readErr?.message ?? 'not found' }, { status: 404 });
  }

  if (row.composio_connection_id) {
    try {
      await disconnect(row.composio_connection_id);
    } catch (e) {
      // Composio-side delete failure shouldn't strand the user — log and
      // continue. They can retry; we still remove our row so the UI doesn't
      // show a ghost connection.
      console.warn('[composio] disconnect at composio failed:', e instanceof Error ? e.message : e);
    }
  }

  const { error: delErr } = await supabase.from('composio_connections').delete().eq('id', id);
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
