/**
 * One-shot backfill: for every legacy fact with signal_id is null, walk its
 * source_event_id → parent_event_id chain (up to 6 hops) looking for the
 * originating signal. Update facts.signal_id when found.
 *
 * Safe to re-run: only touches rows where signal_id is currently null. Facts
 * with no recoverable signal in the chain stay null (the chain route falls
 * back to its legacy walk for them — same behavior as before this column
 * existed).
 *
 * Optional WS_ID env var scopes to a single workspace; default = all.
 */
import { createServerClient } from '@agent-crm/db';

const WS_ID = process.env.WS_ID;

async function resolveSignalForFact(
  sb: ReturnType<typeof createServerClient>,
  startEventId: number,
): Promise<string | null> {
  let cursorId: number | null = startEventId;
  for (let hop = 0; hop < 6 && cursorId != null; hop++) {
    const cur = await sb.from('events')
      .select('id, target_kind, target_id, payload, parent_event_id')
      .eq('id', cursorId).maybeSingle();
    const e = cur.data as {
      id: number; target_kind: string | null; target_id: string | null;
      payload: Record<string, unknown> | null; parent_event_id: number | null;
    } | null;
    if (!e) return null;
    if (e.target_kind === 'signal' && e.target_id) return e.target_id;
    const payloadSig = e.payload && typeof e.payload.signal_id === 'string' ? e.payload.signal_id as string : null;
    if (payloadSig) return payloadSig;
    cursorId = e.parent_event_id;
  }
  return null;
}

async function processBatch(
  sb: ReturnType<typeof createServerClient>,
  rows: Array<{ id: string; source_event_id: number }>,
  concurrency = 20,
) {
  let resolved = 0;
  let nullChain = 0;
  for (let i = 0; i < rows.length; i += concurrency) {
    const slice = rows.slice(i, i + concurrency);
    const results = await Promise.all(slice.map(async (r) => {
      const sigId = await resolveSignalForFact(sb, r.source_event_id);
      return { fact_id: r.id, signal_id: sigId };
    }));
    const updates = results.filter((x) => x.signal_id);
    if (updates.length) {
      await Promise.all(updates.map((u) =>
        sb.from('facts').update({ signal_id: u.signal_id }).eq('id', u.fact_id).is('signal_id', null),
      ));
    }
    resolved += updates.length;
    nullChain += (results.length - updates.length);
    if ((i + concurrency) % 200 === 0 || i + concurrency >= rows.length) {
      console.log(`  progress: ${Math.min(i + concurrency, rows.length)}/${rows.length} resolved=${resolved} null_chain=${nullChain}`);
    }
  }
  return { resolved, nullChain };
}

async function main() {
  const sb = createServerClient();
  const PAGE = 1000;
  let from = 0;
  let totalResolved = 0;
  let totalNull = 0;
  let totalScanned = 0;
  while (true) {
    let q = sb.from('facts').select('id, source_event_id')
      .is('signal_id', null)
      .not('source_event_id', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (WS_ID) q = q.eq('workspace_id', WS_ID);
    const r = await q;
    if (r.error) { console.error('fetch failed:', r.error.message); break; }
    const rows = (r.data ?? []) as Array<{ id: string; source_event_id: number }>;
    if (rows.length === 0) break;
    console.log(`\n--- page from=${from} size=${rows.length} ---`);
    const { resolved, nullChain } = await processBatch(sb, rows);
    totalResolved += resolved;
    totalNull += nullChain;
    totalScanned += rows.length;
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  console.log(`\n=== done ===\nscanned: ${totalScanned}\nresolved: ${totalResolved}\nunresolved: ${totalNull}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
