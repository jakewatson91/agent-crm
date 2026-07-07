import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { callTool } from '@agent-crm/tools';

export const runtime = 'nodejs';

/**
 * POST /api/connectors/contact-budget  { workspace_id, max_contact_pulls_per_run }
 *
 * How many accounts the daily advance pass may spend a contact-provider lookup
 * on. Lives with the Hunter/Explorium cards since it bounds their shared
 * credit burn — separate from each provider's own monthly cap, which is a
 * per-provider field on that provider's card.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    workspace_id?: string; max_contact_pulls_per_run?: number;
  } | null;
  if (!body?.workspace_id) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });

  const supabase = createServerClient();
  const existing = await supabase.from('workspaces').select('policy').eq('id', body.workspace_id).maybeSingle();
  if (existing.error) return NextResponse.json({ error: existing.error.message }, { status: 500 });

  const policy = JSON.parse(JSON.stringify(existing.data?.policy ?? {})) as Record<string, unknown>;
  const enr = (policy.enrichment ?? {}) as Record<string, unknown>;
  policy.enrichment = enr;
  enr.max_contact_pulls_per_run = Number(body.max_contact_pulls_per_run ?? 8);

  const r = await callTool(
    supabase,
    { workspace_id: body.workspace_id, actor_kind: 'user', actor_id: 'web' },
    'set_workspace_policy',
    { policy },
  );
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  return NextResponse.json({ ok: true, event_id: r.event_id });
}
