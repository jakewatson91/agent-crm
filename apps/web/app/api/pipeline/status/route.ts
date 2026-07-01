import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { getPipelineStatus } from '@agent-crm/tools';

export const runtime = 'nodejs';

/**
 * Live pipeline status for the workspace banner: is the daily run healthy,
 * or is it paused waiting on the operator (out of credit / bad key)? Returns
 * { status: null } before the first run has ever recorded state.
 */
export async function GET(req: Request) {
  const workspace_id = new URL(req.url).searchParams.get('workspace_id');
  if (!workspace_id) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });
  const supabase = createServerClient();
  const status = await getPipelineStatus(supabase, workspace_id);
  return NextResponse.json({ status });
}
