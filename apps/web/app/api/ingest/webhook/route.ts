/**
 * Inbound webhook — the primary ingestion on-ramp.
 *
 * Anything that can POST rows (Clay, Zapier, n8n, a migration script) sends
 * them here. We map them to entities + facts via the source's ingest_spec and
 * feed the existing pipeline. Idempotent: same rows pushed twice converge.
 *
 *   POST /api/ingest/webhook?source=<source_id>
 *   Authorization: Bearer acrm_<secret>
 *   body: a bare array, { rows: [...] }, or a single object
 *
 * The mapping spec lives on the source row (sources.config.ingest_spec), so a
 * customer configures it self-serve in Settings → Sources without a code change.
 */
import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { ingestRows, type IngestSpec } from '@agent-crm/tools';
import { resolveActor } from '../../_lib/resolve_api_key';

export const runtime = 'nodejs';

function extractRows(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    const rows = (body as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows;
    return [body]; // a single object is one row
  }
  return [];
}

export async function POST(req: Request) {
  const actor = await resolveActor(req);
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const source_id = url.searchParams.get('source') ?? req.headers.get('x-acrm-source');
  if (!source_id) {
    return NextResponse.json({ error: 'missing ?source=<source_id>' }, { status: 400 });
  }

  const supabase = createServerClient();
  const { data: source, error: srcErr } = await supabase
    .from('sources')
    .select('id, workspace_id, connector_type, name, config')
    .eq('id', source_id)
    .eq('workspace_id', actor.workspace_id)
    .maybeSingle();
  if (srcErr) return NextResponse.json({ error: srcErr.message }, { status: 500 });
  if (!source) return NextResponse.json({ error: 'source not found in this workspace' }, { status: 404 });
  if (source.connector_type !== 'inbound_webhook') {
    return NextResponse.json({ error: `source ${source_id} is not an inbound_webhook` }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  if (body == null) return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  const rows = extractRows(body);
  if (rows.length === 0) return NextResponse.json({ error: 'no rows in payload' }, { status: 400 });

  const cfg = (source.config ?? {}) as { ingest_spec?: IngestSpec };
  const spec = cfg.ingest_spec ?? {};

  const result = await ingestRows(
    supabase,
    { workspace_id: actor.workspace_id },
    rows,
    spec,
    { source_kind: 'webhook', source_ref: source.id as string, source_label: source.name as string },
  );

  return NextResponse.json({ ok: true, result });
}
