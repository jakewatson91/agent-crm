import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { getPipelineStatus } from '@agent-crm/tools';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Manual trigger for the research dispatcher, scoped to one workspace — runs
 * the same due-account selection the 4h cron uses and fires `research.requested`
 * for whatever's due, without waiting for the next tick. Fast: it only picks
 * entities and emits events, the actual Exa searches run async in researchRunner.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { workspace_id?: string } | null;
  if (!body?.workspace_id) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });

  const supabase = createServerClient();
  const status = await getPipelineStatus(supabase, body.workspace_id);
  if (status?.state === 'paused' && (status.scope ?? 'all') !== 'contacts') {
    return NextResponse.json({ ok: false, reason: `still paused: ${status.reason ?? 'pipeline paused'}` }, { status: 409 });
  }

  const { runResearchDispatch } = await import('@agent-crm/inngest/functions');
  const summary = await runResearchDispatch(supabase, { workspaceIds: [body.workspace_id] });
  return NextResponse.json({ ok: true, summary });
}
