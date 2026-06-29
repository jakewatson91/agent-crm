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
