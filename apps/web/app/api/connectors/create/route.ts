/**
 * Wizard save endpoint. Inserts a row into `sources` with the assembled
 * custom_http spec. Idempotent on (workspace_id, name): if a source with
 * the same name exists, updates its config instead of creating a duplicate.
 */
import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';

export const runtime = 'nodejs';

interface CreateReq {
  workspace_id: string;
  name: string;
  spec: Record<string, unknown>;
  schedule_cron?: string;
  active?: boolean;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as CreateReq | null;
  if (!body?.workspace_id || !body?.name || !body?.spec) {
    return NextResponse.json({ error: 'workspace_id, name, spec required' }, { status: 400 });
  }
  const supabase = createServerClient();

  const existing = await supabase
    .from('sources')
    .select('id')
    .eq('workspace_id', body.workspace_id)
    .eq('name', body.name)
    .maybeSingle();

  const row = {
    workspace_id: body.workspace_id,
    name: body.name,
    connector_type: 'custom_http',
    config: body.spec,
    schedule_cron: body.schedule_cron ?? '0 */6 * * *',
    active: body.active ?? true,
  };

  if (existing.data?.id) {
    const upd = await supabase
      .from('sources')
      .update({ config: row.config, schedule_cron: row.schedule_cron, active: row.active })
      .eq('id', existing.data.id);
    if (upd.error) return NextResponse.json({ error: upd.error.message }, { status: 500 });
    return NextResponse.json({ ok: true, source_id: existing.data.id, updated: true });
  }
  const ins = await supabase.from('sources').insert(row).select('id').single();
  if (ins.error) return NextResponse.json({ error: ins.error.message }, { status: 500 });
  return NextResponse.json({ ok: true, source_id: ins.data.id, created: true });
}
