import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
// registry_meta, not registry: only existence + cron default are needed, and
// the full registry's module graph (.js specifiers) breaks turbopack dev.
import { listConnectors } from '@agent-crm/inngest/functions/sources/registry_meta';

export const runtime = 'nodejs';

interface CreateReq {
  workspace_id: string;
  connector_type: string;
  name: string;
  config: Record<string, unknown>;
  schedule_cron?: string;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as CreateReq | null;
  if (!body?.workspace_id || !body?.connector_type || !body?.name) {
    return NextResponse.json({ error: 'workspace_id, connector_type, name required' }, { status: 400 });
  }
  const meta = listConnectors().find((m) => m.type === body.connector_type);
  if (!meta) return NextResponse.json({ error: `unknown connector_type: ${body.connector_type}` }, { status: 400 });

  const supabase = createServerClient();
  const { data, error } = await supabase
    .from('sources')
    .insert({
      workspace_id: body.workspace_id,
      connector_type: body.connector_type,
      name: body.name,
      config: body.config ?? {},
      schedule_cron: body.schedule_cron ?? meta.schedule_cron,
    })
    .select('id')
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, source_id: data.id });
}
