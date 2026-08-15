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

// PostgREST's `authenticator` role carries statement_timeout=8s in its session
// config, and that applies to every API-issued query regardless of which role
// the request switches to. A single UPDATE/DELETE across thousands of rows
// (each touching the HNSW index) can sit right at that wall and get killed —
// confirmed 2026-08-14: the unbatched embedding UPDATE took 7.6s on ~11k rows
// and errored with "canceling statement due to statement timeout" once capped
// at 8s. The event prune goes through an RPC (JSON body, no URL-size limit)
// so it can batch large; the embedding archive selects ids then updates via
// `.in('id', [...])`, which PostgREST encodes into the query string of a PATCH
// request — 2000 UUIDs blew the URL length limit ("Bad Request", also
// confirmed 2026-08-14), so that path needs a much smaller batch.
const EVENT_PRUNE_BATCH = 2000;
const EMBEDDING_ARCHIVE_BATCH = 200;

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
  //    its HNSW index. signals.UPDATE is allowed for service_role. Batched —
  //    see the batch-size comment above for why a single unbatched UPDATE fails.
  const ttlDays = ret.signal_embedding_ttl_days ?? 0;
  if (ttlDays > 0) {
    const cutoff = new Date(Date.now() - ttlDays * DAY_MS).toISOString();
    for (;;) {
      const { data: batch, error: selErr } = await supabase
        .from('signals')
        .select('id')
        .eq('workspace_id', workspace_id)
        .lt('created_at', cutoff)
        .not('embedding', 'is', null)
        .limit(EMBEDDING_ARCHIVE_BATCH);
      if (selErr) {
        console.error(`[retention ${workspace_id}] signal batch select failed: ${selErr.message}`);
        break;
      }
      const ids = (batch ?? []).map((r) => r.id as string);
      if (ids.length === 0) break;
      const upd = await supabase.from('signals').update({ embedding: null }).in('id', ids);
      if (upd.error) {
        console.error(`[retention ${workspace_id}] signal embedding archive failed: ${upd.error.message}`);
        break;
      }
      result.embeddings_archived += ids.length;
      if (ids.length < EMBEDDING_ARCHIVE_BATCH) break;
    }
  }

  // 2. Prune telemetry events older than the window (provenance-safe via the
  //    SECURITY DEFINER function — direct DELETE is revoked on events).
  //    Batched via prune_events' p_limit (migration 0053) for the same reason.
  const evTtl = ret.event_ttl_days ?? 0;
  const actions = ret.prunable_event_actions ?? [];
  if (evTtl > 0 && actions.length > 0) {
    const cutoff = new Date(Date.now() - evTtl * DAY_MS).toISOString();
    for (;;) {
      const pruned = await supabase.rpc('prune_events', {
        p_workspace_id: workspace_id,
        p_actions: actions,
        p_cutoff: cutoff,
        p_limit: EVENT_PRUNE_BATCH,
      });
      if (pruned.error) {
        console.error(`[retention ${workspace_id}] event prune failed: ${pruned.error.message}`);
        break;
      }
      const n = (pruned.data as number) ?? 0;
      result.events_pruned += n;
      if (n < EVENT_PRUNE_BATCH) break;
    }
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
