/**
 * POST /api/agent_actions/undo  { event_id }
 *
 * Reverses an agent_action_taken event (currently from the source curator).
 * Idempotent: if already undone, returns the existing counter-event id.
 *
 * Inverse rules:
 *   deactivate                 → set sources.active=true
 *   rewrite_query              → restore sources.config from payload.prior_state.config
 *                                (read via the underlying update_source event)
 *   add_catchall_subscription  → set the created subscription.active=false
 *                                (don't delete — preserves the audit chain)
 *
 * Writes a counter-event `agent_action_undone` with original_event_id in payload.
 */
import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';

export const runtime = 'nodejs';

interface AgentActionPayload {
  action_type?: 'deactivate' | 'rewrite_query' | 'add_catchall_subscription';
  source_id?: string;
  underlying_event_id?: string | null;
  created_subscription_id?: string | null;
}

interface UnderlyingEventPayload {
  prior_state?: { active?: boolean; config?: Record<string, unknown> };
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as { event_id?: string; workspace_id?: string } | null;
  if (!body?.event_id || !body?.workspace_id) {
    return NextResponse.json({ error: 'event_id and workspace_id required' }, { status: 400 });
  }

  const sb = createServerClient();

  // Load the original action event, scoped to workspace.
  const evRes = await sb.from('events')
    .select('id, workspace_id, action, payload')
    .eq('id', body.event_id)
    .eq('workspace_id', body.workspace_id)
    .maybeSingle();
  if (evRes.error) return NextResponse.json({ error: evRes.error.message }, { status: 500 });
  if (!evRes.data || evRes.data.action !== 'agent_action_taken') {
    return NextResponse.json({ error: 'not an agent_action_taken event for this workspace' }, { status: 404 });
  }
  const payload = (evRes.data.payload ?? {}) as AgentActionPayload;
  const action_type = payload.action_type;
  const source_id = payload.source_id;
  if (!action_type || !source_id) return NextResponse.json({ error: 'event payload missing action_type or source_id' }, { status: 400 });

  // Idempotency check. Compare on stringified event_id because the payload
  // may have been written as a number (from JSON-typed API responses) or a
  // string (from curl bodies). Either form should resolve as "already undone".
  const target = String(body.event_id);
  const dupRes = await sb.from('events')
    .select('id, payload')
    .eq('workspace_id', body.workspace_id)
    .eq('action', 'agent_action_undone')
    .limit(1000);
  for (const u of (dupRes.data ?? []) as Array<{ id: string; payload: { original_event_id?: string | number } | null }>) {
    const stored = u.payload?.original_event_id;
    if (stored != null && String(stored) === target) {
      return NextResponse.json({ ok: true, already_undone: true, undo_event_id: u.id });
    }
  }

  // Apply the inverse.
  let applied: Record<string, unknown> = {};
  let errMsg: string | null = null;
  try {
    if (action_type === 'deactivate') {
      const r = await sb.from('sources').update({ active: true }).eq('id', source_id).eq('workspace_id', body.workspace_id);
      if (r.error) throw new Error(r.error.message);
      applied = { active: true };
    } else if (action_type === 'rewrite_query') {
      // Read prior_state.config from the underlying update_source event.
      const undId = payload.underlying_event_id;
      if (!undId) throw new Error('rewrite_query event has no underlying_event_id');
      const underRes = await sb.from('events').select('payload').eq('id', undId).maybeSingle();
      const underPayload = (underRes.data?.payload ?? {}) as UnderlyingEventPayload;
      const priorConfig = underPayload.prior_state?.config;
      if (!priorConfig) throw new Error('underlying event has no prior_state.config');
      const r = await sb.from('sources').update({ config: priorConfig }).eq('id', source_id).eq('workspace_id', body.workspace_id);
      if (r.error) throw new Error(r.error.message);
      applied = { config: priorConfig };
    } else if (action_type === 'add_catchall_subscription') {
      const subId = payload.created_subscription_id;
      if (!subId) throw new Error('add_catchall_subscription event has no created_subscription_id');
      const r = await sb.from('subscriptions').update({ active: false }).eq('id', subId).eq('workspace_id', body.workspace_id);
      if (r.error) throw new Error(r.error.message);
      applied = { subscription_id: subId, active: false };
    } else {
      throw new Error(`unknown action_type: ${action_type}`);
    }
  } catch (e) {
    errMsg = (e as Error).message;
  }

  if (errMsg) return NextResponse.json({ error: errMsg }, { status: 500 });

  // Write the counter-event.
  const counter = await sb.from('events').insert({
    workspace_id: body.workspace_id,
    actor_kind: 'user',
    actor_id: 'undo_endpoint',
    action: 'agent_action_undone',
    target_kind: 'source',
    target_id: source_id,
    payload: { original_event_id: body.event_id, action_type, applied },
  }).select('id').single();

  return NextResponse.json({ ok: true, undo_event_id: counter.data?.id ?? null });
}
