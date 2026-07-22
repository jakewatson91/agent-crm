import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { getPipelineStatus, setPipelineStatus } from '@agent-crm/tools';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Clear a pause. The operator topped up credit / fixed the key and clicked
 * Continue — flip the status off 'paused' so the next scheduled run resumes
 * where it left off (it picks up the un-drafted accounts by score order, so
 * nothing is lost). No-op if the pipeline isn't paused.
 *
 * If the pause covered research, also fire the research dispatcher for this
 * workspace right now (same selection logic the 4h cron uses) instead of
 * making the operator wait for the next tick.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { workspace_id?: string } | null;
  if (!body?.workspace_id) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });
  const supabase = createServerClient();

  const status = await getPipelineStatus(supabase, body.workspace_id);
  if (status?.state !== 'paused') {
    return NextResponse.json({ ok: true, already: true, status });
  }
  const scope = status.scope ?? 'all';
  const next = { state: 'ok' as const, last_run_at: status.last_run_at, last_run: status.last_run };
  await setPipelineStatus(supabase, body.workspace_id, next);

  let research_summary: unknown = null;
  if (scope === 'research' || scope === 'all') {
    const { runResearchDispatch } = await import('@agent-crm/inngest/functions');
    research_summary = await runResearchDispatch(supabase, { workspaceIds: [body.workspace_id] });
  }
  return NextResponse.json({ ok: true, status: next, research_summary });
}
