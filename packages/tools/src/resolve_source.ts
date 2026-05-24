/**
 * resolveSourceForFacts: given a list of fact ids, return the originating
 * source (id, name, connector_type) for each fact, when one can be determined.
 *
 * Chain: fact.source_event_id → events.payload.signal_id (when the fact was
 * asserted by an agent reacting to a specific signal) → signals.structured_tags.source_id
 * → sources.
 *
 * Facts that were asserted out-of-band (manual injects, scoring, drafter notes,
 * etc.) won't have a resolvable source — those keys are simply absent in the
 * returned map, not error rows. Callers should treat absence as "no known source".
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface FactSource {
  source_id: string;
  source_name: string;
  connector_type: string;
}

export async function resolveSourceForFacts(
  sb: SupabaseClient,
  fact_ids: string[],
): Promise<Map<string, FactSource>> {
  const out = new Map<string, FactSource>();
  if (fact_ids.length === 0) return out;

  const factRes = await sb.from('facts').select('id, source_event_id').in('id', fact_ids);
  if (factRes.error) throw new Error(`facts: ${factRes.error.message}`);
  const facts = (factRes.data ?? []) as Array<{ id: string; source_event_id: number | null }>;
  const eventIds = [...new Set(facts.map((f) => f.source_event_id).filter((x): x is number => x != null))];
  if (eventIds.length === 0) return out;

  const evRes = await sb.from('events').select('id, payload').in('id', eventIds);
  if (evRes.error) throw new Error(`events: ${evRes.error.message}`);
  const events = (evRes.data ?? []) as Array<{ id: number; payload: { signal_id?: string } | null }>;
  const sigIdByEventId = new Map<number, string>();
  for (const e of events) {
    const sid = e.payload?.signal_id;
    if (sid) sigIdByEventId.set(e.id, sid);
  }

  const signalIds = [...new Set([...sigIdByEventId.values()])];
  if (signalIds.length === 0) return out;
  const sigRes = await sb.from('signals').select('id, structured_tags').in('id', signalIds);
  if (sigRes.error) throw new Error(`signals: ${sigRes.error.message}`);
  const sourceIdBySignal = new Map<string, string>();
  for (const s of (sigRes.data ?? []) as Array<{ id: string; structured_tags: { source_id?: string } | null }>) {
    const src = s.structured_tags?.source_id;
    if (src) sourceIdBySignal.set(s.id, src);
  }

  const sourceIds = [...new Set([...sourceIdBySignal.values()])];
  if (sourceIds.length === 0) return out;
  const srcRes = await sb.from('sources').select('id, name, connector_type').in('id', sourceIds);
  if (srcRes.error) throw new Error(`sources: ${srcRes.error.message}`);
  const sourceById = new Map<string, FactSource>();
  for (const s of (srcRes.data ?? []) as Array<{ id: string; name: string; connector_type: string }>) {
    sourceById.set(s.id, { source_id: s.id, source_name: s.name, connector_type: s.connector_type });
  }

  for (const f of facts) {
    if (f.source_event_id == null) continue;
    const sigId = sigIdByEventId.get(f.source_event_id);
    if (!sigId) continue;
    const srcId = sourceIdBySignal.get(sigId);
    if (!srcId) continue;
    const meta = sourceById.get(srcId);
    if (meta) out.set(f.id, meta);
  }
  return out;
}
