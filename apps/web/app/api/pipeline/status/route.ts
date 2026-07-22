import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { getPipelineStatus, cronToMinIntervalMinutes, RESEARCH_DISPATCH_CRON } from '@agent-crm/tools';

export const runtime = 'nodejs';

const RESEARCH_DISPATCH_INTERVAL_HOURS = cronToMinIntervalMinutes(RESEARCH_DISPATCH_CRON) / 60;

/**
 * Live pipeline status for the workspace banner: is the daily run healthy,
 * or is it paused waiting on the operator (out of credit / bad key)? Returns
 * { status: null } before the first run has ever recorded state.
 *
 * Also returns the research dispatcher's cadence so the banner can show
 * "next automatic run" — the cron always fires on the hour, so the client
 * computes the next boundary from wall-clock time, no server state needed.
 */
export async function GET(req: Request) {
  const workspace_id = new URL(req.url).searchParams.get('workspace_id');
  if (!workspace_id) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });
  const supabase = createServerClient();
  const status = await getPipelineStatus(supabase, workspace_id);
  return NextResponse.json({ status, research_dispatch_interval_hours: RESEARCH_DISPATCH_INTERVAL_HOURS });
}
