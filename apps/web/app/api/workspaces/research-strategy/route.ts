/**
 * POST /api/workspaces/research-strategy { workspace_id }
 *
 * Regenerates the AI research strategy (search angles) from the workspace's saved
 * About / ICP / guidance, persists it to workspaces.policy.research.strategy, and
 * returns the angles. Used by the settings "Regenerate" button and called after an
 * About/guidance change so the strategy stays in sync without manual editing.
 */
import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { generateResearchStrategy, persistResearchStrategy } from '@agent-crm/tools';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as { workspace_id?: string } | null;
  if (!body?.workspace_id) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });

  const supabase = createServerClient();
  const { angles, source, error } = await generateResearchStrategy(supabase, body.workspace_id);
  try {
    await persistResearchStrategy(supabase, body.workspace_id, angles);
  } catch (e) {
    return NextResponse.json({ error: `persist failed: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
  }
  return NextResponse.json({ ok: true, angles, source, planner_error: error ?? null });
}
