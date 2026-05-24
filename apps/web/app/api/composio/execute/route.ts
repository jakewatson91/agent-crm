import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { execute, findAction, classifyUnknown } from '@agent-crm/composio';
import type { ToolScope } from '@agent-crm/composio';

export const runtime = 'nodejs';

/**
 * POST /api/composio/execute
 *
 * Body: { workspace_id, action_slug, arguments, force? }
 *
 * Executes a Composio action on behalf of a workspace. Scope gating:
 *  - `read`: always runs.
 *  - `write`: runs unless workspace policy requires approval (then 412).
 *  - `dangerous`: requires `force: true` (the caller must have already
 *    cleared the gate) OR workspace policy `composio.auto_dangerous`.
 *
 * Audit: every execute lands in `events` with action='composio.execute',
 * the slug, arguments, and result. Inherits the same provenance discipline
 * as every other tool call.
 */
export async function POST(req: Request) {
  let body: { workspace_id?: string; action_slug?: string; arguments?: Record<string, unknown>; force?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json body' }, { status: 400 });
  }
  const workspace_id = body.workspace_id?.trim();
  const action_slug = body.action_slug?.trim().toUpperCase();
  const args = body.arguments ?? {};
  const force = Boolean(body.force);
  if (!workspace_id || !action_slug) {
    return NextResponse.json({ error: 'workspace_id and action_slug required' }, { status: 400 });
  }

  const supabase = createServerClient();

  // Confirm the workspace has an active connection for this toolkit.
  const found = findAction(action_slug);
  const scope: ToolScope = found?.action.scope ?? classifyUnknown(action_slug);
  const toolkit_slug = found?.toolkit.slug ?? action_slug.split('_')[0]?.toLowerCase();
  if (!toolkit_slug) {
    return NextResponse.json({ error: `cannot infer toolkit from ${action_slug}` }, { status: 400 });
  }

  const { data: conn } = await supabase
    .from('composio_connections')
    .select('id, status')
    .eq('workspace_id', workspace_id)
    .eq('toolkit_slug', toolkit_slug)
    .maybeSingle();
  if (!conn || conn.status !== 'active') {
    return NextResponse.json(
      { error: `no active connection for toolkit "${toolkit_slug}". connect it in settings first.` },
      { status: 412 },
    );
  }

  // v1: read-only. Outbound (send / post / create) is deferred.
  if (scope !== 'read') {
    return NextResponse.json(
      { error: `non-read actions are not exposed in v1 (action ${action_slug} is ${scope})`, scope },
      { status: 412 },
    );
  }

  const result = await execute(workspace_id, action_slug, args);

  // Audit every execution. Truncate arguments to keep events table sane.
  const argSummary = JSON.stringify(args).slice(0, 2000);
  await supabase.from('events').insert({
    workspace_id,
    actor_kind: 'agent',
    actor_id: 'composio',
    action: 'composio.execute',
    target_kind: 'composio_connection',
    target_id: conn.id,
    payload: {
      action_slug,
      toolkit_slug,
      scope,
      arguments_preview: argSummary,
      ok: result.ok,
      error: result.error,
    },
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? 'composio execute failed' }, { status: 502 });
  }
  return NextResponse.json({ ok: true, data: result.data });
}
