/**
 * Retention — keeps the two unbounded tables (signals, events) from growing
 * forever. Reversible / provenance-safe by construction:
 *   - signal embeddings are nulled (recomputable from body_for_embedding), the
 *     row + body + facts stay;
 *   - only whitelisted telemetry events are deleted, and prune_events (0039)
 *     refuses to delete any event a fact references.
 *
 * Driven entirely by workspaces.policy.retention (off by default). Callable from
 * the launchd loop (run_loop) and from an Inngest cron; an internal ~daily
 * throttle (a `retention_run` marker event) makes both callers idempotent so it
 * runs at most once/day per workspace no matter how often tick() fires.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getPolicy } from './policy.ts';

const THROTTLE_MS = 20 * 60 * 60 * 1000; // 20h — runs ~once/day even on an hourly loop
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionResult {
  workspace_id: string;
  skipped: boolean;
  embeddings_archived: number;
  events_pruned: number;
}

export async function runRetention(
  supabase: SupabaseClient,
  workspace_id: string,
  opts: { force?: boolean } = {},
): Promise<RetentionResult> {
  const result: RetentionResult = { workspace_id, skipped: false, embeddings_archived: 0, events_pruned: 0 };

  // Throttle: skip if we already ran within THROTTLE_MS (shared by all callers).
  if (!opts.force) {
    const last = await supabase
      .from('events')
      .select('created_at')
      .eq('workspace_id', workspace_id)
      .eq('action', 'retention_run')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const lastTs = last.data?.created_at ? new Date(last.data.created_at).getTime() : 0;
    if (Date.now() - lastTs < THROTTLE_MS) {
      result.skipped = true;
      return result;
    }
  }

  const { retention } = await getPolicy(supabase, workspace_id);
  const ret = retention ?? {};

  // 1. Archive old signal embeddings (keep row/body/facts). Bounds signals +
  //    its HNSW index. signals.UPDATE is allowed for service_role.
  const ttlDays = ret.signal_embedding_ttl_days ?? 0;
  if (ttlDays > 0) {
    const cutoff = new Date(Date.now() - ttlDays * DAY_MS).toISOString();
    const count = await supabase
      .from('signals')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspace_id)
      .lt('created_at', cutoff)
      .not('embedding', 'is', null);
    const n = count.count ?? 0;
    if (n > 0) {
      const upd = await supabase
        .from('signals')
        .update({ embedding: null })
        .eq('workspace_id', workspace_id)
        .lt('created_at', cutoff)
        .not('embedding', 'is', null);
      if (!upd.error) result.embeddings_archived = n;
    }
  }

  // 2. Prune telemetry events older than the window (provenance-safe via the
  //    SECURITY DEFINER function — direct DELETE is revoked on events).
  const evTtl = ret.event_ttl_days ?? 0;
  const actions = ret.prunable_event_actions ?? [];
  if (evTtl > 0 && actions.length > 0) {
    const cutoff = new Date(Date.now() - evTtl * DAY_MS).toISOString();
    const pruned = await supabase.rpc('prune_events', {
      p_workspace_id: workspace_id,
      p_actions: actions,
      p_cutoff: cutoff,
    });
    if (!pruned.error) result.events_pruned = (pruned.data as number) ?? 0;
  }

  // Marker (doubles as the throttle clock). INSERT is allowed on events.
  await supabase.from('events').insert({
    workspace_id,
    actor_kind: 'system',
    actor_id: 'retention',
    action: 'retention_run',
    target_kind: 'workspace',
    target_id: workspace_id,
    payload: { embeddings_archived: result.embeddings_archived, events_pruned: result.events_pruned },
  });

  return result;
}
