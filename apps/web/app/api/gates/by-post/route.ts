import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';

export const runtime = 'nodejs';

/**
 * Resolve the gate (if any) tied to a channel_post. Used by the draft card
 * inline buttons to know whether an approval exists and what its current
 * state is. Returns `{ gate: null }` if no gate exists for this post.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const post_id = url.searchParams.get('post_id');
  if (!post_id) return NextResponse.json({ error: 'post_id required' }, { status: 400 });

  const supabase = createServerClient();
  const { data, error } = await supabase
    .from('gates')
    .select('id, policy, condition, decision, decided_at, requested_at, channel_post_id')
    .eq('channel_post_id', post_id)
    .order('requested_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ gate: data ?? null });
}
