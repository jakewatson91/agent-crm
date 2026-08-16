/**
 * Activity markers — "the system did something to this entity at time T."
 *
 * These describe what the pipeline DID (kicked off research, pulled contacts),
 * not what is TRUE about the account. They are not facts, so they live in the
 * append-only event log, not the facts table. Written as facts, they inflated
 * evidence_depth and recency in scoring (the scorer counted them as substantive
 * evidence and the freshest "fact" was always a self-ping). Moved here 2026-06.
 *
 * One module is the single source of truth for the action names so a writer and
 * a reader can never drift apart — which is exactly the bug that let the scorer
 * and the sweep disagree about what counts as evidence.
 *
 * Cooldown reads (action_selector, research dispatcher) and health checks
 * (sweep, contacts drain) all read these back by action name + target entity.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAll } from './paginate.ts';

export const ACTIVITY_MARKERS = {
  RESEARCH_TRIGGERED: 'research_triggered',
  RESEARCH_COMPLETED: 'research_completed',
  RESEARCH_ERROR: 'research_error',
  CONTACTS_REQUESTED: 'contacts_requested',
  CONTACTS_COMPLETED: 'contacts_completed',
  // The rescore cron attempted this entity and scoreAndAssert returned null
  // (candidate-flagged, dropped, or nothing changed). Since a null writes no
  // fact, the entity would otherwise look stale forever and hog the cron's
  // per-tick budget — the scan skips entities whose marker postdates the last
  // scoring-config change.
  RESCORE_NOOP: 'rescore_noop',
  // Search-based domain resolution (resolveDomainViaSearch) set attributes.domain
  // on this entity / tried and found nothing that passed the name-match guard.
  // The research runner and the bulk backfill read the FAILED marker as a
  // cooldown so they don't re-spend a search on the same account every tick.
  DOMAIN_RESOLVED: 'domain_resolved',
  DOMAIN_RESOLVE_FAILED: 'domain_resolve_failed',
  // resolveAliasesViaSearch stored the other names this account's coverage runs
  // under / found nothing on its own site that passed the alias guards. The
  // backfill reads the FAILED marker as a cooldown, the same way the domain
  // sweep does, so repeat runs spend their searches on untried accounts.
  ALIASES_RESOLVED: 'aliases_resolved',
  ALIASES_RESOLVE_FAILED: 'aliases_resolve_failed',
} as const;

export type ActivityMarker = (typeof ACTIVITY_MARKERS)[keyof typeof ACTIVITY_MARKERS];

interface MarkerActor {
  workspace_id: string;
  actor_kind: 'agent' | 'user' | 'system';
  actor_id: string;
}

/**
 * Append an activity marker to the event log for one entity. Best-effort: every
 * caller treats a failed marker as non-fatal (the next cron tick retries), so we
 * swallow the error here to match the prior assert_fact try/catch sites.
 */
export async function recordActivityMarker(
  supabase: SupabaseClient,
  actor: MarkerActor,
  action: ActivityMarker,
  entity_id: string,
  payload: Record<string, unknown> = {},
  parent_event_id?: string | number | null,
): Promise<void> {
  try {
    await supabase.from('events').insert({
      workspace_id: actor.workspace_id,
      actor_kind: actor.actor_kind,
      actor_id: actor.actor_id,
      action,
      target_kind: 'entity',
      target_id: entity_id,
      payload,
      parent_event_id: parent_event_id ?? null,
    });
  } catch {
    /* non-fatal: cooldown just won't extend this tick; next run re-records */
  }
}

/**
 * Most recent timestamp (ISO string) of the given marker action(s) for one
 * entity, or null. Backs the per-entity cooldown reads in action_selector.
 */
export async function latestMarkerAt(
  supabase: SupabaseClient,
  workspace_id: string,
  entity_id: string,
  actions: ActivityMarker[],
): Promise<string | null> {
  const res = await supabase
    .from('events')
    .select('created_at')
    .eq('workspace_id', workspace_id)
    .eq('target_kind', 'entity')
    .eq('target_id', entity_id)
    .in('action', actions)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (res.data?.created_at as string) ?? null;
}

/**
 * Latest marker timestamp (epoch ms) per entity, across a set of entities.
 * Backs the research dispatcher's tiering pass. Pages with fetchAll so a
 * workspace with >1000 marker events doesn't silently truncate (the same cap
 * that produced false "0% coupling" alarms — see paginate.ts).
 */
export async function latestMarkerByEntity(
  supabase: SupabaseClient,
  workspace_id: string,
  entity_ids: string[],
  actions: ActivityMarker[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const CHUNK = 200;
  for (let i = 0; i < entity_ids.length; i += CHUNK) {
    const chunk = entity_ids.slice(i, i + CHUNK);
    const rows = await fetchAll<{ target_id: string; created_at: string }>((from, to) =>
      supabase
        .from('events')
        .select('target_id, created_at')
        .eq('workspace_id', workspace_id)
        .eq('target_kind', 'entity')
        .in('action', actions)
        .in('target_id', chunk)
        .order('created_at', { ascending: true })
        .range(from, to),
    );
    for (const r of rows) {
      const ts = Date.parse(r.created_at);
      if (Number.isFinite(ts) && ts > (out.get(r.target_id) ?? 0)) out.set(r.target_id, ts);
    }
  }
  return out;
}

/**
 * How many research passes in a row have come back with nothing, per entity.
 *
 * The dispatcher's other backoff reads signal_strength, which is what we BELIEVE
 * about an account. That number sits high on an account whose facts all arrived
 * in a CSV import while the open web has nothing to say about it, so those
 * accounts were revisited on exactly the same cadence as the ones that pay.
 *
 * Measured on the 2,132-account Sudden book over the 14 days to 2026-08-16: 333
 * of 559 research runs (60%) created zero facts, out of 2,241 searches costing
 * $15.69. This counts the runs that found nothing so the dispatcher can wait
 * longer before trying those accounts again.
 *
 * Counts backwards from the most recent run and stops at the first one that
 * created a fact, so one productive pass clears the whole count. Entities with
 * no completed run inside the window are left out of the map (read as zero) —
 * never-researched accounts must not inherit a penalty. `research_error` runs
 * are not counted either: a provider outage is not the web being empty.
 */
export async function countTrailingEmptyResearch(
  supabase: SupabaseClient,
  workspace_id: string,
  entity_ids: string[],
  lookbackDays = 90,
): Promise<Map<string, number>> {
  const since = new Date(Date.now() - lookbackDays * 86400_000).toISOString();
  const runsByEntity = new Map<string, Array<{ at: number; created: number }>>();
  const CHUNK = 200;
  for (let i = 0; i < entity_ids.length; i += CHUNK) {
    const chunk = entity_ids.slice(i, i + CHUNK);
    const rows = await fetchAll<{ target_id: string; created_at: string; payload: { results_created?: number } | null }>((from, to) =>
      supabase
        .from('events')
        .select('target_id, created_at, payload')
        .eq('workspace_id', workspace_id)
        .eq('target_kind', 'entity')
        .eq('action', ACTIVITY_MARKERS.RESEARCH_COMPLETED)
        .in('target_id', chunk)
        .gte('created_at', since)
        .order('created_at', { ascending: true })
        .range(from, to),
    );
    for (const r of rows) {
      const at = Date.parse(r.created_at);
      if (!Number.isFinite(at)) continue;
      const list = runsByEntity.get(r.target_id) ?? [];
      list.push({ at, created: Number(r.payload?.results_created ?? 0) || 0 });
      runsByEntity.set(r.target_id, list);
    }
  }
  const out = new Map<string, number>();
  for (const [id, runs] of runsByEntity) {
    runs.sort((a, b) => b.at - a.at); // newest first
    let n = 0;
    for (const r of runs) {
      if (r.created > 0) break;
      n++;
    }
    if (n > 0) out.set(id, n);
  }
  return out;
}
