/**
 * GET /api/agent_actions/list?workspace_id=...&limit=N
 *
 * Returns the most recent reversible actions the agent took on its own
 * (currently: source curator mutations). Each row includes whether it has
 * been undone, so the UI can render undo affordances per row.
 */
import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';

export const runtime = 'nodejs';

interface AgentActionRow {
  id: string;
  created_at: string;
  payload: {
    action_type?: string;
    source_id?: string;
    source_name?: string;
    reasoning?: string;
    new_query?: string | null;
    new_subscription_semantic?: string | null;
    created_subscription_id?: string | null;
    metrics_snapshot?: Record<string, number> | null;
  } | null;
}

interface UndoRow {
  payload: { original_event_id?: string } | null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspace_id = url.searchParams.get('workspace_id');
  if (!workspace_id) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });
  const limit = Math.min(Number(url.searchParams.get('limit') ?? '20') || 20, 100);

  const sb = createServerClient();

  const [actsRes, undosRes] = await Promise.all([
    sb.from('events')
      .select('id, created_at, payload')
      .eq('workspace_id', workspace_id)
      .eq('action', 'agent_action_taken')
      .order('created_at', { ascending: false })
      .limit(limit),
    sb.from('events')
      .select('payload')
      .eq('workspace_id', workspace_id)
      .eq('action', 'agent_action_undone')
      .limit(500),
  ]);
  if (actsRes.error) return NextResponse.json({ error: actsRes.error.message }, { status: 500 });

  const undoneIds = new Set<string>();
  for (const u of (undosRes.data ?? []) as UndoRow[]) {
    const id = u.payload?.original_event_id;
    if (id) undoneIds.add(id);
  }

  const actions = ((actsRes.data ?? []) as AgentActionRow[]).map((row) => ({
    event_id: row.id,
    taken_at: row.created_at,
    action_type: row.payload?.action_type ?? 'unknown',
    source_id: row.payload?.source_id ?? null,
    source_name: row.payload?.source_name ?? '(unknown)',
    reasoning: row.payload?.reasoning ?? '',
    new_query: row.payload?.new_query ?? null,
    new_subscription_semantic: row.payload?.new_subscription_semantic ?? null,
    created_subscription_id: row.payload?.created_subscription_id ?? null,
    metrics_snapshot: row.payload?.metrics_snapshot ?? null,
    undone: undoneIds.has(row.id),
  }));

  return NextResponse.json({ actions });
}
