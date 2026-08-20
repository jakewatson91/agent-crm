/**
 * POST /api/workspaces/research-strategy { workspace_id }
 *
 * Regenerates the AI research strategy (search angles) from the workspace's saved
 * About / ICP / guidance, persists it to workspaces.policy.research.strategy, and
 * returns the angles. Used by the settings "Regenerate" button and called after an
 * About/guidance change so the strategy stays in sync without manual editing.
 *
 * The BRIEF is ensured first, and the order matters. Every angle carries
 * `answers: <brief question id>`, so generating angles against a workspace whose
 * brief does not exist yet writes angles pointing at the neutral baseline's
 * question ids — and the moment the dispatcher generates the real brief, every
 * one of those angles refers to a question that is not there. Same order as
 * entity_research_dispatcher, for the same reason.
 */
import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { generateResearchStrategy, persistResearchStrategy, recordStrategyAttempt, ensureResearchBrief, getPolicy, resolveStrategy } from '@agent-crm/tools';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as { workspace_id?: string } | null;
  if (!body?.workspace_id) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });

  const supabase = createServerClient();
  const brief = await ensureResearchBrief(supabase, body.workspace_id);
  const { angles, source, error } = await generateResearchStrategy(supabase, body.workspace_id);

  // Same guard the dispatcher applies, and this path needed it more: it used to
  // persist unconditionally, so pressing Regenerate while the planner was down
  // replaced a working strategy with BASELINE_ANGLES — whose questions belong to
  // the baseline brief, so every angle in the workspace would then be buying
  // pages for a question the brief does not contain. Keeping what is stored is
  // strictly better than that, and the caller is told the attempt failed.
  const policy = await getPolicy(supabase, body.workspace_id);
  const stored = policy.research?.strategy ?? [];
  if (source === 'baseline' && stored.length) {
    await recordStrategyAttempt(supabase, body.workspace_id, error).catch(() => { /* report the failure regardless */ });
    return NextResponse.json({
      ok: false,
      angles: resolveStrategy(policy),
      brief,
      source,
      planner_error: error ?? 'the planner did not return a usable strategy',
      kept_existing: true,
    });
  }

  try {
    await persistResearchStrategy(supabase, body.workspace_id, angles);
  } catch (e) {
    return NextResponse.json({ error: `persist failed: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
  }
  return NextResponse.json({ ok: true, angles, brief, source, planner_error: error ?? null });
}
