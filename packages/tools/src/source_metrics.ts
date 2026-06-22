/**
 * Per-source health metrics. Pure read function — no writes, no side effects.
 *
 * Answers, for each source in a workspace: am I pulling my weight?
 *
 *   - signals: how many signals did I create in the window
 *   - unmatched_rate: % of those signals that have entity_id = null
 *     (the matcher couldn't link them to an account)
 *   - agent_fire_rate: % of those signals that triggered any agent_run_metrics
 *     event (i.e. some subscription's filter+embedding matched)
 *   - fact_yield: average fact assertions per signal that fired the enricher
 *   - entities_seeded: count of entities whose earliest signal came from this source
 *
 * Single-window query — caller picks 24h or 7d. Returns one row per source,
 * including sources with zero signals (so callers can flag dead sources).
 *
 * Performance: at workspace scales of ~100 signals/day, one round-trip per
 * table is fine. The query joins are kept inline rather than via RPC to stay
 * with PostgREST's typed surface. Move to a Postgres function if a workspace
 * pushes past ~10k signals/day.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAll } from './paginate.ts';

export interface SourceMetric {
  source_id: string;
  name: string;
  connector_type: string;
  active: boolean;
  schedule_cron: string | null;
  window_hours: number;
  signals: number;
  unmatched_rate: number;
  agent_fire_rate: number;
  fact_yield: number;
  entities_seeded: number;
}

interface SignalRow {
  id: string;
  entity_id: string | null;
  structured_tags: { source_id?: string } | null;
}

interface EventRow {
  action: string;
  payload: { signal_id?: string; behavior?: string; ok?: boolean; facts_asserted?: number } | null;
}

interface SourceRow {
  id: string;
  name: string;
  connector_type: string;
  active: boolean;
  schedule_cron: string | null;
}

interface EntityFirstSeen {
  source_id: string;
}

export async function getSourceMetrics(
  sb: SupabaseClient,
  workspace_id: string,
  window_hours: number,
): Promise<SourceMetric[]> {
  const since = new Date(Date.now() - window_hours * 3600 * 1000).toISOString();

  // All three windowed reads paginate via fetchAll — at high volume (tens of
  // thousands of signals in 7d) a bare .limit() returns only the oldest 1000,
  // which silently undercounted per-source signals/fact_yield and drove the
  // source_curator + source_dead_weight check off stale data.
  const [srcRes, signals, events, entityFirstSignal] = await Promise.all([
    sb.from('sources')
      .select('id, name, connector_type, active, schedule_cron')
      .eq('workspace_id', workspace_id),
    fetchAll<SignalRow>((f, t) => sb.from('signals')
      .select('id, entity_id, structured_tags')
      .eq('workspace_id', workspace_id)
      .gte('created_at', since)
      .order('id').range(f, t)),
    fetchAll<EventRow>((f, t) => sb.from('events')
      .select('action, payload')
      .eq('workspace_id', workspace_id)
      .in('action', ['agent_run_metrics', 'agent_dispatch_result'])
      .gte('created_at', since)
      .order('id').range(f, t)),
    // entities_seeded: every signal that attached to an entity, bucketed by
    // source on the EARLIEST one per entity — so created_at ascending is load-
    // bearing here, with id as a tiebreaker for stable pagination.
    fetchAll<{ entity_id: string; structured_tags: { source_id?: string } | null; created_at: string }>((f, t) => sb.from('signals')
      .select('entity_id, structured_tags, created_at')
      .eq('workspace_id', workspace_id)
      .gte('created_at', since)
      .not('entity_id', 'is', null)
      .order('created_at', { ascending: true }).order('id').range(f, t)),
  ]);

  if (srcRes.error) throw new Error(`sources: ${srcRes.error.message}`);

  const sources = (srcRes.data ?? []) as SourceRow[];

  // Index by source_id
  const signalsBySource = new Map<string, SignalRow[]>();
  for (const s of signals) {
    const sid = s.structured_tags?.source_id;
    if (!sid) continue;
    const arr = signalsBySource.get(sid) ?? [];
    arr.push(s);
    signalsBySource.set(sid, arr);
  }

  // Build signal_id → source_id for the events join
  const signalSourceById = new Map<string, string>();
  for (const s of signals) {
    const sid = s.structured_tags?.source_id;
    if (sid) signalSourceById.set(s.id, sid);
  }

  // Per-source counts. Two event kinds:
  //   agent_run_metrics      — emitted once per LLM call (any behavior)
  //                            → drives agent_fire_rate
  //   agent_dispatch_result  — emitted after a successful enricher dispatch
  //                            → drives fact_yield (facts_asserted per signal)
  const agentFiredSignalsBySource = new Map<string, Set<string>>();
  const factsAssertedBySource = new Map<string, number>();
  const factEventsBySource = new Map<string, number>();
  for (const e of events) {
    const sigId = e.payload?.signal_id;
    if (!sigId) continue;
    const srcId = signalSourceById.get(sigId);
    if (!srcId) continue;
    if (e.action === 'agent_run_metrics') {
      const set = agentFiredSignalsBySource.get(srcId) ?? new Set();
      set.add(sigId);
      agentFiredSignalsBySource.set(srcId, set);
    } else if (e.action === 'agent_dispatch_result' && e.payload?.behavior === 'enricher' && e.payload?.ok) {
      factEventsBySource.set(srcId, (factEventsBySource.get(srcId) ?? 0) + 1);
      factsAssertedBySource.set(srcId, (factsAssertedBySource.get(srcId) ?? 0) + (e.payload?.facts_asserted ?? 0));
    }
  }

  // entities_seeded: first signal per entity, bucket by source.
  const seenEntity = new Set<string>();
  const seededCountBySource = new Map<string, number>();
  for (const row of entityFirstSignal) {
    if (seenEntity.has(row.entity_id)) continue;
    seenEntity.add(row.entity_id);
    const sid = row.structured_tags?.source_id;
    if (!sid) continue;
    seededCountBySource.set(sid, (seededCountBySource.get(sid) ?? 0) + 1);
  }

  return sources.map((s) => {
    const sigs = signalsBySource.get(s.id) ?? [];
    const unmatched = sigs.filter((x) => x.entity_id == null).length;
    const fired = agentFiredSignalsBySource.get(s.id)?.size ?? 0;
    const factEvents = factEventsBySource.get(s.id) ?? 0;
    const factsAsserted = factsAssertedBySource.get(s.id) ?? 0;
    return {
      source_id: s.id,
      name: s.name,
      connector_type: s.connector_type,
      active: s.active,
      schedule_cron: s.schedule_cron,
      window_hours,
      signals: sigs.length,
      unmatched_rate: sigs.length ? unmatched / sigs.length : 0,
      agent_fire_rate: sigs.length ? fired / sigs.length : 0,
      fact_yield: factEvents ? factsAsserted / factEvents : 0,
      entities_seeded: seededCountBySource.get(s.id) ?? 0,
    };
  });
}
