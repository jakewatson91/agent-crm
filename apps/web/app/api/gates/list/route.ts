import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspace_id = url.searchParams.get('workspace_id');
  if (!workspace_id) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });

  const supabase = createServerClient();
  // One round trip: gates → channel_post → channel via nested PostgREST select.
  const { data: gates, error } = await supabase
    .from('gates')
    .select(`
      id, requested_by_agent, channel_post_id, policy, condition, requested_at,
      channel_post:channel_posts(
        id, kind, body, cites,
        channel:channels(id, account_entity_id, title)
      )
    `)
    .eq('workspace_id', workspace_id)
    .is('decided_at', null)
    .order('requested_at', { ascending: false })
    .limit(50);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  type GateRow = {
    id: string;
    requested_by_agent: string;
    channel_post_id: string | null;
    policy: string;
    condition: Record<string, unknown>;
    requested_at: string;
    channel_post: {
      id: string; kind: string; body: string; cites: string[];
      channel: { id: string; account_entity_id: string; title: string } | null;
    } | null;
  };

  const enriched = ((gates ?? []) as unknown as GateRow[]).map((g) => {
    const post = g.channel_post;
    const channel = post?.channel ?? null;
    return {
      id: g.id,
      requested_by_agent: g.requested_by_agent,
      policy: g.policy,
      condition: g.condition,
      requested_at: g.requested_at,
      channel_post_id: g.channel_post_id,
      post_kind: post?.kind ?? null,
      post_body: post?.body ?? null,
      post_cites: post?.cites ?? [],
      account_title: channel?.title ?? null,
      channel_id: channel?.id ?? null,
    };
  });

  return NextResponse.json({ gates: enriched });
}
