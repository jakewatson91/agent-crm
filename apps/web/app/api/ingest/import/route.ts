/**
 * One-time CSV migration import — the escape hatch for bringing an old CRM in.
 *
 * The client parses the CSV (or any export) into row objects keyed by column
 * header and posts them with a column→field mapping. We feed the same idempotent
 * ingestRows core, so re-running or later pushing the same rows via the webhook
 * converges instead of duplicating.
 *
 *   POST /api/ingest/import   (session-authed, admin)
 *   body: { workspace_id, rows: object[], spec: IngestSpec }
 *
 * `spec` paths are the CSV column names (rows are flat header-keyed objects).
 */
import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { ingestRows, type IngestSpec } from '@agent-crm/tools';
import { getUser, getWorkspaceRole, hasRole } from '../../../_lib/auth';
import { createServiceClient } from '../../../_lib/supabase-server';

export const runtime = 'nodejs';
export const maxDuration = 300;

interface ImportReq {
  workspace_id: string;
  rows: unknown[];
  spec: IngestSpec;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as ImportReq | null;
  if (!body?.workspace_id || !Array.isArray(body.rows) || !body.spec) {
    return NextResponse.json({ error: 'workspace_id, rows[], spec required' }, { status: 400 });
  }
  if (body.rows.length === 0) {
    return NextResponse.json({ error: 'no rows to import' }, { status: 400 });
  }

  const user = await getUser();
  if (!user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  const role = await getWorkspaceRole(user.id, body.workspace_id);
  if (!hasRole(role, 'admin')) {
    return NextResponse.json({ error: 'admin or owner required' }, { status: 403 });
  }

  const sb = createServiceClient();
  const result = await ingestRows(
    sb,
    { workspace_id: body.workspace_id },
    body.rows,
    body.spec,
    { source_kind: 'import_csv', source_ref: randomUUID(), source_label: 'CSV import' },
  );

  return NextResponse.json({ ok: true, result });
}
