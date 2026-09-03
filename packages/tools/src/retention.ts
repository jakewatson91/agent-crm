/**
 * Retention — keeps the tables that grow unbounded (signals, events, facts)
 * from growing forever. Reversible / provenance-safe by construction:
 *   - signal embeddings are nulled (recomputable from body_for_embedding), the
 *     row + body + facts stay;
 *   - only whitelisted telemetry events are deleted, and prune_events (0039)
 *     refuses to delete any event a fact references;
 *   - only whitelisted fact predicates roll up (prune_fact_history, 0058):
 *     the current value of every fact is untouched, and old (superseded)
 *     readings only go once a later reading in the same period exists to
 *     stand in for them, so a metric built from the history still spans the
 *     account's full life at whatever resolution fact_history_grain sets.
 *     Freeing a fact this way is also what lets its assert_fact /
 *     supersede_fact event clear on the same pass, since prune_events refuses
 *     to delete an event any fact still points to.
 *
 * Driven entirely by workspaces.policy.retention (off by default). Callable from
 * the launchd loop (run_loop) and from an Inngest cron; an internal ~daily
 * throttle (a `retention_run` marker event) makes both callers idempotent so it
 * runs at most once/day per workspace no matter how often tick() fires.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getPolicy } from './policy.ts';
import { isSubstantiveFact } from './scoring.ts';

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
//
// The fact and event batches were 2000 and are 500, measured 2026-09-03 on the
// first monthly-grain pass. A batch's cost is mostly the scan that finds the
// candidates, not the rows it deletes, so it is worst when there is a backlog
// and the caches are cold: the first batch of 2000 facts took 5.4s and the
// first batch of 2000 events took 7.0s, both against an 8s wall, and the same
// call over PostgREST was killed mid-batch. Later batches ran in under a
// second. A batch that cannot finish is not slow, it is a job that makes zero
// progress and stays stuck forever, so the size has to fit the cold case with
// room, and 500 costs only more round trips.
const EVENT_PRUNE_BATCH = 500;
const EMBEDDING_ARCHIVE_BATCH = 200;
const FACT_HISTORY_PRUNE_BATCH = 500;

// pg_net's internal async-HTTP response log (net._http_response) — not app
// data, not workspace-scoped. Found holding ~46MB of dead rows against ~500
// live ones (2026-08-14): nothing prunes it on its own. A day is generous
// headroom over how long anything actually needs a row before it's stale.
const HTTP_RESPONSE_TTL_MS = DAY_MS;
const HTTP_RESPONSE_PRUNE_BATCH = 2000;

export interface RetentionResult {
  workspace_id: string;
  skipped: boolean;
  embeddings_archived: number;
  events_pruned: number;
  fact_history_pruned: number;
}

export async function runRetention(
  supabase: SupabaseClient,
  workspace_id: string,
  opts: { force?: boolean } = {},
): Promise<RetentionResult> {
  const result: RetentionResult = { workspace_id, skipped: false, embeddings_archived: 0, events_pruned: 0, fact_history_pruned: 0 };

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

  // 2. Roll up old fact history (migrations 0058, 0060): for whitelisted
  //    predicates (score_total and its scoring inputs — never a one-off
  //    account fact), delete superseded readings older than the window once a
  //    later reading in the same period exists to replace them. Keeps one
  //    reading per entity/predicate/period forever plus the chain's original —
  //    a metric built from this still spans the account's full history, just
  //    at the grain's resolution instead of per-recompute past the window.
  //    'day' is the default and reaches very little on a book that scores about
  //    once a day; 'month' is what a workspace sets when it would rather have
  //    the space than the resolution. Runs before the event prune below so the
  //    assert_fact/supersede_fact events those deleted facts were the last
  //    reference to become eligible in the same pass.
  const factTtl = ret.fact_history_ttl_days ?? 0;
  // A structural floor, not just config discipline: even if a predicate that
  // scoring treats as real evidence about the account ever lands in this
  // list by mistake, it never reaches the delete function. isSubstantiveFact
  // is the same boundary scoreEntity already uses to decide what counts as
  // evidence, so a predicate can't be "safe to prune" here and "real
  // evidence" there at the same time.
  const configuredPredicates = ret.prunable_fact_predicates ?? [];
  const rejected = configuredPredicates.filter((p) => isSubstantiveFact(p));
  if (rejected.length > 0) {
    console.error(`[retention ${workspace_id}] refusing to prune substantive predicate(s) found in prunable_fact_predicates: ${rejected.join(', ')}`);
  }
  const factPredicates = configuredPredicates.filter((p) => !isSubstantiveFact(p));
  if (factTtl > 0 && factPredicates.length > 0) {
    const cutoff = new Date(Date.now() - factTtl * DAY_MS).toISOString();
    for (;;) {
      const pruned = await supabase.rpc('prune_fact_history', {
        p_workspace_id: workspace_id,
        p_predicates: factPredicates,
        p_cutoff: cutoff,
        p_limit: FACT_HISTORY_PRUNE_BATCH,
        p_grain: ret.fact_history_grain ?? 'day',
      });
      if (pruned.error) {
        console.error(`[retention ${workspace_id}] fact history prune failed: ${pruned.error.message}`);
        break;
      }
      const n = (pruned.data as number) ?? 0;
      result.fact_history_pruned += n;
      if (n < FACT_HISTORY_PRUNE_BATCH) break;
    }
  }

  // 3. Prune telemetry events older than the window (provenance-safe via the
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
    payload: { embeddings_archived: result.embeddings_archived, events_pruned: result.events_pruned, fact_history_pruned: result.fact_history_pruned },
  });

  return result;
}

export interface HttpResponsePruneResult {
  skipped: boolean;
  deleted: number;
}

/**
 * Global (not per-workspace) — deletes pg_net's stale async-HTTP response
 * rows via the prune_http_responses SECURITY DEFINER function (migration
 * 0054; service_role has no direct grant on net._http_response, it's owned by
 * supabase_admin). Only deletes; it does not shrink the file on disk — VACUUM
 * can't run inside a function or over PostgREST, so that part lives in the
 * launchd loop's direct connection, same constraint as the HNSW reindex.
 * `marker_workspace_id` just satisfies events.workspace_id's FK for the
 * throttle marker — this isn't scoped to that workspace.
 */
export async function pruneHttpResponses(
  supabase: SupabaseClient,
  marker_workspace_id: string,
  opts: { force?: boolean } = {},
): Promise<HttpResponsePruneResult> {
  const result: HttpResponsePruneResult = { skipped: false, deleted: 0 };

  if (!opts.force) {
    const last = await supabase
      .from('events')
      .select('created_at')
      .eq('action', 'http_response_prune_run')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const lastTs = last.data?.created_at ? new Date(last.data.created_at).getTime() : 0;
    if (Date.now() - lastTs < THROTTLE_MS) {
      result.skipped = true;
      return result;
    }
  }

  const cutoff = new Date(Date.now() - HTTP_RESPONSE_TTL_MS).toISOString();
  for (;;) {
    const pruned = await supabase.rpc('prune_http_responses', { p_cutoff: cutoff, p_limit: HTTP_RESPONSE_PRUNE_BATCH });
    if (pruned.error) {
      console.error(`[retention http_response] prune failed: ${pruned.error.message}`);
      break;
    }
    const n = (pruned.data as number) ?? 0;
    result.deleted += n;
    if (n < HTTP_RESPONSE_PRUNE_BATCH) break;
  }

  await supabase.from('events').insert({
    workspace_id: marker_workspace_id,
    actor_kind: 'system',
    actor_id: 'retention',
    action: 'http_response_prune_run',
    target_kind: 'workspace',
    target_id: marker_workspace_id,
    payload: { deleted: result.deleted },
  });

  return result;
}
