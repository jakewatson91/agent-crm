import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspace_id = url.searchParams.get('workspace_id');
  if (!workspace_id) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });

  const supabase = createServerClient();
  // Fetch pending gates + the channel_post they reference (body, kind, cites, channel_id)
  // and the entity for that channel (so we can show the account name).
  const { data: gates, error } = await supabase
    .from('gates')
    .select('id, requested_by_agent, channel_post_id, policy, condition, requested_at')
    .eq('workspace_id', workspace_id)
    .is('decided_at', null)
    .order('requested_at', { ascending: false })
    .limit(50);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const postIds = (gates ?? []).map((g) => g.channel_post_id).filter((x): x is string => !!x);
  const posts = postIds.length
    ? (await supabase.from('channel_posts').select('id, channel_id, kind, body, cites').in('id', postIds)).data ?? []
    : [];
  const postById = new Map(posts.map((p) => [p.id as string, p]));

  const channelIds = Array.from(new Set(posts.map((p) => p.channel_id as string)));
  const channels = channelIds.length
    ? (await supabase.from('channels').select('id, account_entity_id, title').in('id', channelIds)).data ?? []
    : [];
  const channelById = new Map(channels.map((c) => [c.id as string, c]));

  const enriched = (gates ?? []).map((g) => {
    const post = g.channel_post_id ? postById.get(g.channel_post_id as string) : undefined;
    const channel = post ? channelById.get(post.channel_id as string) : undefined;
    return {
      id: g.id as string,
      requested_by_agent: g.requested_by_agent as string,
      policy: g.policy as string,
      condition: g.condition as Record<string, unknown>,
      requested_at: g.requested_at as string,
      channel_post_id: g.channel_post_id as string | null,
      post_kind: post?.kind ?? null,
      post_body: post?.body ?? null,
      post_cites: post?.cites ?? [],
      account_title: channel?.title ?? null,
      channel_id: channel?.id ?? null,
    };
  });

  return NextResponse.json({ gates: enriched });
}
