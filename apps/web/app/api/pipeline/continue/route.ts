import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { getPipelineStatus, setPipelineStatus } from '@agent-crm/tools';

export const runtime = 'nodejs';

/**
 * Clear a pause. The operator topped up credit / fixed the key and clicked
 * Continue — flip the status off 'paused' so the next scheduled run resumes
 * where it left off (it picks up the un-drafted accounts by score order, so
 * nothing is lost). No-op if the pipeline isn't paused.
 *
 * Note: this does NOT itself kick a run. While the daily loop runs locally
 * (launchd), the next scheduled pass resumes; there is nothing to re-trigger
 * server-side. The banner tells the operator this.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { workspace_id?: string } | null;
  if (!body?.workspace_id) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });
  const supabase = createServerClient();

  const status = await getPipelineStatus(supabase, body.workspace_id);
  if (status?.state !== 'paused') {
    return NextResponse.json({ ok: true, already: true, status });
  }
  const next = { state: 'ok' as const, last_run_at: status.last_run_at, last_run: status.last_run };
  await setPipelineStatus(supabase, body.workspace_id, next);
  return NextResponse.json({ ok: true, status: next });
}
