import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { callTool } from '@agent-crm/tools';

export const runtime = 'nodejs';

interface CreateReq {
  workspace_id: string;
  // Pre-parsed (and potentially user-edited) subscription params.
  params: {
    name: string;
    owner_id: string;
    semantic_query: string;
    structured_filter: Record<string, unknown>;
    threshold: number;
    action_on_match: string;
    agent_behavior?: 'claim_poster' | 'drafter';
    model?: string;
  };
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as CreateReq | null;
  if (!body?.workspace_id || !body?.params) {
    return NextResponse.json({ error: 'workspace_id and params required' }, { status: 400 });
  }
  const p = body.params;
  if (!p.owner_id || !p.name || !p.semantic_query || typeof p.threshold !== 'number') {
    return NextResponse.json({ error: 'params must include owner_id, name, semantic_query, threshold' }, { status: 400 });
  }

  const supabase = createServerClient();
  const r = await callTool(
    supabase,
    { workspace_id: body.workspace_id, actor_kind: 'agent', actor_id: 'meta_agent_creator' },
    'create_subscription',
    {
      owner_kind: 'agent',
      owner_id: p.owner_id,
      name: p.name,
      semantic_query: p.semantic_query,
      structured_filter: p.structured_filter ?? {},
      threshold: p.threshold,
      action_on_match: p.action_on_match ?? 'agent.run',
    },
  );
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });

  // Apply agent_behavior + model if provided. The create_subscription tool's
  // payload doesn't carry these yet, so we set them via a follow-up UPDATE.
  const directUpdate: Record<string, unknown> = {};
  const behavior = p.agent_behavior ?? 'claim_poster';
  if (behavior !== 'claim_poster') directUpdate.agent_behavior = behavior;
  if (p.model && p.model.trim().length > 0) directUpdate.model = p.model;
  if (Object.keys(directUpdate).length > 0) {
    const upd = await supabase.from('subscriptions').update(directUpdate).eq('id', r.target_id);
    if (upd.error) return NextResponse.json({ error: `subscription created but follow-up update failed: ${upd.error.message}`, subscription_id: r.target_id }, { status: 500 });
  }

  return NextResponse.json({ ok: true, subscription_id: r.target_id, event_id: r.event_id });
}
