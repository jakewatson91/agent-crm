/**
 * CSV column mapping suggestion — one LLM call over headers + sample values.
 * The import wizard calls this as soon as a file is parsed, then lets the
 * user adjust before running /api/ingest/import. Read-only: no rows written.
 *
 *   POST /api/ingest/suggest-mapping   (session-authed, admin)
 *   body: { workspace_id, columns: string[], sample_rows: object[] }
 */
import { NextResponse } from 'next/server';
import { suggestColumnMapping } from '@agent-crm/tools';
import { getUser, getWorkspaceRole, hasRole } from '../../../_lib/auth';
import { createServiceClient } from '../../../_lib/supabase-server';

export const runtime = 'nodejs';
export const maxDuration = 60;

interface SuggestReq {
  workspace_id: string;
  columns: string[];
  sample_rows: Record<string, string>[];
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as SuggestReq | null;
  if (!body?.workspace_id || !Array.isArray(body.columns) || !Array.isArray(body.sample_rows)) {
    return NextResponse.json({ error: 'workspace_id, columns[], sample_rows[] required' }, { status: 400 });
  }

  const user = await getUser();
  if (!user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  const role = await getWorkspaceRole(user.id, body.workspace_id);
  if (!hasRole(role, 'admin')) {
    return NextResponse.json({ error: 'admin or owner required' }, { status: 403 });
  }

  const sb = createServiceClient();
  const suggestion = await suggestColumnMapping(sb, body.workspace_id, body.columns, body.sample_rows);
  return NextResponse.json({ ok: true, suggestion });
}
