import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { callTool } from '@agent-crm/tools';
import { getUser } from '../../../../_lib/auth';

export const runtime = 'nodejs';

/**
 * A person recording what they know about an account.
 *
 * Session-authenticated sibling of the `add_note` MCP tool — same tool, same
 * write path, so a note typed in the browser and one filed by an agent are
 * indistinguishable downstream. Middleware has already verified the session;
 * the cookie read here is a lookup so the audit trail records WHICH person
 * wrote it rather than the literal string 'web'.
 *
 * The workspace comes from the entity row, not the request body, so a caller
 * cannot aim a note at an account outside the workspace they are looking at.
 */
export async function POST(req: Request, { params }: { params: Promise<{ entity_id: string }> }) {
  const { entity_id } = await params;
  if (!entity_id) return NextResponse.json({ error: 'entity_id required' }, { status: 400 });

  const body = (await req.json().catch(() => null)) as {
    note?: string;
    happened_at?: string | null;
    source?: string | null;
  } | null;
  const note = body?.note?.trim();
  if (!note) return NextResponse.json({ error: 'note required' }, { status: 400 });

  const supabase = createServerClient();
  const ent = await supabase.from('entities').select('workspace_id').eq('id', entity_id).maybeSingle();
  if (ent.error || !ent.data) return NextResponse.json({ error: 'entity not found' }, { status: 404 });

  const user = await getUser().catch(() => null);
  const actor = {
    workspace_id: ent.data.workspace_id as string,
    actor_kind: 'user' as const,
    actor_id: user?.id ?? 'web',
  };

  // A date-only value from <input type="date"> is midnight UTC of that day,
  // which is what "this happened on the 3rd" means. Anything else is passed
  // through and the tool's schema rejects what it cannot use.
  const happened_at = body?.happened_at
    ? (/^\d{4}-\d{2}-\d{2}$/.test(body.happened_at) ? `${body.happened_at}T00:00:00.000Z` : body.happened_at)
    : undefined;

  const result = await callTool(supabase, actor, 'add_note', {
    entity_id,
    note,
    ...(happened_at ? { happened_at } : {}),
    ...(body?.source?.trim() ? { source: body.source.trim() } : {}),
  });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true, ...(result.data ?? {}) });
}
