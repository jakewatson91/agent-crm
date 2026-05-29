/**
 * Shared Bearer-key actor resolution. Both /api/mcp and /api/ingest/webhook
 * authenticate the same way: `Authorization: Bearer acrm_<secret>` resolves to
 * a workspace + actor via workspace_api_keys (SHA-256 hashed at rest).
 *
 * Dev-only fallback (NODE_ENV !== 'production'): x-workspace-id + x-actor-kind +
 * x-actor-id headers, for local scripts/smoke tests without a provisioned key.
 */
import { createHash } from 'node:crypto';
import { createServerClient } from '@agent-crm/db';
import type { ActorKind } from '@agent-crm/primitives';

export interface ResolvedActor {
  workspace_id: string;
  actor_kind: ActorKind;
  actor_id: string;
}

export async function resolveActor(req: Request): Promise<ResolvedActor | null> {
  const auth = req.headers.get('authorization') ?? '';
  const m = auth.match(/^Bearer\s+(acrm_[A-Za-z0-9_-]+)$/);
  if (m) {
    const secret = m[1]!;
    const key_hash = createHash('sha256').update(secret).digest('hex');
    const sb = createServerClient();
    const { data } = await sb.from('workspace_api_keys')
      .select('id, workspace_id, created_by, revoked_at')
      .eq('key_hash', key_hash)
      .maybeSingle();
    if (!data || data.revoked_at) return null;
    // Touch last_used_at; fire-and-forget.
    sb.from('workspace_api_keys').update({ last_used_at: new Date().toISOString() })
      .eq('id', data.id).then(() => undefined);
    return {
      workspace_id: data.workspace_id,
      actor_kind: 'user',
      actor_id: data.created_by,
    };
  }

  if (process.env.NODE_ENV !== 'production') {
    const ws = req.headers.get('x-workspace-id');
    const kind = req.headers.get('x-actor-kind') as ActorKind | null;
    const id = req.headers.get('x-actor-id');
    if (ws && kind && id) return { workspace_id: ws, actor_kind: kind, actor_id: id };
  }

  return null;
}
