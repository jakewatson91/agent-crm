import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { maskEnv } from '../../_lib/secret_mask';

export const runtime = 'nodejs';

const getWorkspace = async (workspace_id: string) => {
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from('workspaces')
    .select('id, name, persona, icp, budget_cents, policy, constitution, about, knowledge_base, created_at, updated_at')
    .eq('id', workspace_id)
    .single();
  if (error) return { error: error.message, code: error.code } as const;
  // Mask secret-shaped env values before returning. The embedding caches used
  // to live in policy (150KB+) and were stripped here; they now live in their
  // own embedding_cache column which this route never selects, so the
  // cache-key destructure below is a harmless guard for old/in-flight rows.
  if (data?.policy && typeof data.policy === 'object') {
    const { icp_embedding_cache: _ie, pitch_embedding_cache: _pe, env, ...rest } = data.policy as Record<string, unknown>;
    // Mask secret-shaped env values so DevTools / network captures / support
    // sessions don't expose them. The agent loop still reads the real values
    // server-side via getPolicy().
    data.policy = { ...rest, env: maskEnv(env as Record<string, string> | undefined) };
  }
  return { workspace: data } as const;
};

export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspace_id = url.searchParams.get('workspace_id');
  if (!workspace_id) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });
  const result = await getWorkspace(workspace_id);
  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: result.code === 'PGRST116' ? 404 : 500 });
  }
  return NextResponse.json(result);
}
