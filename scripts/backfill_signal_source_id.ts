/**
 * Backfill signals.structured_tags.source_id from the actor_id pattern on each
 * signal's source_event_id.
 *
 * Actor ids written by connectors are `source:<connector_type>:<8char_prefix>`.
 * The 8-char prefix is uniquely resolvable to sources.id (uuid collisions in
 * the first 8 chars within a workspace are vanishingly unlikely; we tie-break
 * on connector_type as well to be safe).
 *
 * Idempotent: only touches signals where structured_tags.source_id is missing.
 * Safe to re-run; safe to ctrl-c (next run picks up where it left off).
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const BATCH = 500;

interface SourceRow { id: string; connector_type: string; workspace_id: string }
interface SignalRow { id: string; structured_tags: Record<string, unknown> | null; source_event_id: number | null; workspace_id: string }
interface EventRow { id: number; actor_id: string }

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const srcRes = await sb.from('sources').select('id, connector_type, workspace_id');
  if (srcRes.error) { console.error(srcRes.error.message); process.exit(1); }
  const sources = (srcRes.data ?? []) as SourceRow[];
  // Key: `${connector_type}:${prefix8}|${workspace_id}` → source_id
  const lookup = new Map<string, string>();
  for (const s of sources) lookup.set(`${s.connector_type}:${s.id.slice(0, 8)}|${s.workspace_id}`, s.id);
  console.log(`loaded ${sources.length} sources into lookup`);

  let processed = 0;
  let updated = 0;
  let unresolved = 0;
  while (true) {
    // Need raw SQL-style filter on jsonb — use ->> for text extraction. PostgREST `not.cs.{source_id}`
    // works for "tag exists" check. Use `.is('structured_tags->source_id', null)` instead.
    const sigRes = await sb.from('signals')
      .select('id, structured_tags, source_event_id, workspace_id')
      .is('structured_tags->source_id', null)
      .not('source_event_id', 'is', null)
      .limit(BATCH);
    if (sigRes.error) { console.error(sigRes.error.message); process.exit(1); }
    const signals = (sigRes.data ?? []) as SignalRow[];
    if (signals.length === 0) break;

    const eventIds = [...new Set(signals.map(s => s.source_event_id).filter((x): x is number => x != null))];
    const evRes = await sb.from('events').select('id, actor_id').in('id', eventIds);
    if (evRes.error) { console.error(evRes.error.message); process.exit(1); }
    const eventById = new Map<number, EventRow>();
    for (const e of (evRes.data ?? []) as EventRow[]) eventById.set(e.id, e);

    const updates: Array<{ id: string; structured_tags: Record<string, unknown> }> = [];
    for (const sig of signals) {
      if (sig.source_event_id == null) { unresolved++; continue; }
      const ev = eventById.get(sig.source_event_id);
      if (!ev) { unresolved++; continue; }
      const m = /^source:([^:]+):([0-9a-f]{8})$/.exec(ev.actor_id);
      if (!m) { unresolved++; continue; }
      const [, connectorType, prefix] = m;
      const key = `${connectorType}:${prefix}|${sig.workspace_id}`;
      const sourceId = lookup.get(key);
      if (!sourceId) { unresolved++; continue; }
      const newTags = { ...(sig.structured_tags ?? {}), source_id: sourceId };
      updates.push({ id: sig.id, structured_tags: newTags });
    }

    for (const u of updates) {
      const r = await sb.from('signals').update({ structured_tags: u.structured_tags }).eq('id', u.id);
      if (r.error) console.error(`update ${u.id} failed: ${r.error.message}`);
      else updated++;
    }
    processed += signals.length;
    console.log(`batch: processed=${signals.length}  updated=${updates.length}  total_updated=${updated}  total_unresolved=${unresolved}`);
    if (signals.length < BATCH) break;
  }
  console.log(`\ndone. processed=${processed} updated=${updated} unresolved=${unresolved}`);
}

main().catch(e => { console.error(e); process.exit(1); });
