import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { getConnector } from '@agent-crm/inngest/functions/sources/registry';

export const runtime = 'nodejs';

interface RunReq {
  source_id: string;
}

/**
 * Manual trigger for a source — runs the connector synchronously and returns the
 * result. Useful for testing newly configured sources without waiting for the cron.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as RunReq | null;
  if (!body?.source_id) return NextResponse.json({ error: 'source_id required' }, { status: 400 });

  const supabase = createServerClient();
  const { data: source, error } = await supabase
    .from('sources')
    .select('id, workspace_id, connector_type, config, last_run_at')
    .eq('id', body.source_id)
    .single();
  if (error || !source) return NextResponse.json({ error: error?.message ?? 'source not found' }, { status: 404 });

  const conn = getConnector(source.connector_type as string);
  if (!conn) return NextResponse.json({ error: `unknown connector_type: ${source.connector_type}` }, { status: 400 });

  const out = await conn.run({
    supabase,
    workspace_id: source.workspace_id as string,
    source_id: source.id as string,
    config: (source.config ?? {}) as Record<string, unknown>,
    last_run_at: (source.last_run_at as string | null) ?? null,
  });

  const status = out.errors.length === 0 ? 'ok' : 'error';
  await supabase
    .from('sources')
    .update({
      last_run_at: new Date().toISOString(),
      last_run_status: status,
      last_run_summary: {
        signals_created: out.signals_created,
        entities_created: out.entities_created,
        skipped: out.skipped,
        errors: out.errors.slice(0, 5),
      },
    })
    .eq('id', source.id);

  return NextResponse.json({ ok: status === 'ok', summary: out });
}
