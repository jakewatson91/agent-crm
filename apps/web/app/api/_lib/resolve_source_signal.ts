import type { SupabaseClient } from '@supabase/supabase-js';
import { pickSourceUrl, type StructuredTags } from './source_url';

/**
 * Resolve a fact's originating signal by walking the event chain backwards.
 *
 * Starting at each event, we check three things in order:
 *   1. event.target_kind === 'signal' → target_id is the signal id.
 *   2. event.payload.signal_id is set → that's the signal id.
 *   3. follow event.parent_event_id and repeat.
 *
 * Capped at MAX_HOPS to keep one bad chain from running unbounded.
 *
 * Batch version: takes a set of starting event ids and resolves all of them
 * in a small number of round-trips, returning a Map<startEventId, signalInfo>.
 */
const MAX_HOPS = 6;

export interface SourceSignal {
  source_name: string | null;
  source_url: string | null;
}

interface EventRow {
  id: number;
  target_kind: string | null;
  target_id: string | null;
  payload: Record<string, unknown> | null;
  parent_event_id: number | null;
}

function readSignalIdFromEvent(e: EventRow): string | null {
  if (e.target_kind === 'signal' && e.target_id) return e.target_id;
  if (e.payload && typeof e.payload === 'object') {
    const p = e.payload as Record<string, unknown>;
    if (typeof p.signal_id === 'string') return p.signal_id;
  }
  return null;
}

export async function resolveSourceSignalsBatch(
  supabase: SupabaseClient,
  startEventIds: number[],
  /**
   * Heuristic fallback for events whose parent chain doesn't terminate at a
   * signal-targeted event (typically historical assert_fact rows written
   * before the enricher started threading parent_event_id). For each
   * unresolved event, look up the most recent signal.created event for the
   * fact's subject_entity at-or-before the assert_fact's created_at. Off by
   * default; pass `enableHistoricalFallback: true` to enable.
   */
  options?: { enableHistoricalFallback?: boolean },
): Promise<Map<number, SourceSignal>> {
  const out = new Map<number, SourceSignal>();
  if (startEventIds.length === 0) return out;

  const current = new Map<number, number>();
  for (const id of startEventIds) current.set(id, id);

  const signalIdByStart = new Map<number, string>();
  const firstHopEvById = new Map<number, EventRow>();

  for (let hop = 0; hop < MAX_HOPS && current.size > 0; hop++) {
    const idsToFetch = Array.from(new Set(current.values()));
    const evRes = await supabase
      .from('events')
      .select('id, target_kind, target_id, payload, parent_event_id')
      .in('id', idsToFetch);
    const events = (evRes.data ?? []) as EventRow[];
    const evById = new Map<number, EventRow>();
    for (const e of events) evById.set(e.id, e);
    if (hop === 0) {
      for (const e of events) firstHopEvById.set(e.id, e);
    }

    const nextCurrent = new Map<number, number>();
    for (const [startId, evId] of current) {
      const ev = evById.get(evId);
      if (!ev) continue;
      const sigId = readSignalIdFromEvent(ev);
      if (sigId) {
        signalIdByStart.set(startId, sigId);
        continue;
      }
      if (ev.parent_event_id != null) {
        nextCurrent.set(startId, ev.parent_event_id);
      }
    }
    current.clear();
    for (const [k, v] of nextCurrent) current.set(k, v);
  }

  // Historical fallback for facts whose chain didn't yield a signal.
  if (options?.enableHistoricalFallback) {
    const unresolved = startEventIds.filter((id) => !signalIdByStart.has(id));
    if (unresolved.length > 0) {
      // Pull each unresolved start event (with payload.subject_entity + created_at).
      const evRes = await supabase
        .from('events')
        .select('id, workspace_id, payload, created_at')
        .in('id', unresolved);
      const evs = (evRes.data ?? []) as Array<{
        id: number;
        workspace_id: string;
        payload: Record<string, unknown> | null;
        created_at: string;
      }>;
      // Group by (workspace_id, subject_entity) to batch the lookups.
      const byKey = new Map<string, Array<{ eventId: number; createdAt: string }>>();
      for (const e of evs) {
        const subj = e.payload && typeof (e.payload as Record<string, unknown>).subject_entity === 'string'
          ? (e.payload as Record<string, unknown>).subject_entity as string
          : null;
        if (!subj) continue;
        const key = `${e.workspace_id}::${subj}`;
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key)!.push({ eventId: e.id, createdAt: e.created_at });
      }
      for (const [key, items] of byKey) {
        const [workspace_id, subj] = key.split('::');
        // Use the latest createdAt as the upper bound; a single query per entity.
        const latest = items.reduce((acc, x) => (x.createdAt > acc ? x.createdAt : acc), items[0]!.createdAt);
        const sigEvRes = await supabase
          .from('events')
          .select('id, target_id, created_at')
          .eq('workspace_id', workspace_id)
          .eq('target_kind', 'signal')
          .lte('created_at', latest)
          .contains('payload', { entity_id: subj })
          .order('created_at', { ascending: false })
          .limit(20);
        const sigEvs = (sigEvRes.data ?? []) as Array<{ id: number; target_id: string | null; created_at: string }>;
        for (const item of items) {
          // For each unresolved fact event, pick the signal event with the largest created_at <= item.createdAt.
          const match = sigEvs.find((s) => s.created_at <= item.createdAt);
          if (match?.target_id) signalIdByStart.set(item.eventId, match.target_id);
        }
      }
    }
  }

  const signalIds = Array.from(new Set(signalIdByStart.values()));
  const tagsBySignalId = new Map<string, StructuredTags | null>();
  if (signalIds.length > 0) {
    const sigRes = await supabase
      .from('signals')
      .select('id, structured_tags')
      .in('id', signalIds);
    for (const s of (sigRes.data ?? []) as Array<{ id: string; structured_tags: StructuredTags | null }>) {
      tagsBySignalId.set(s.id, s.structured_tags);
    }
  }

  for (const [startId, sigId] of signalIdByStart) {
    const tags = tagsBySignalId.get(sigId) ?? null;
    const source_name = tags?.signal_source ?? null;
    const source_url = pickSourceUrl(tags);
    if (source_name || source_url) out.set(startId, { source_name, source_url });
  }
  return out;
}
