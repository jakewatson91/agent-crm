import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { cite } from '@agent-crm/primitives';
import { pickSourceUrl, type StructuredTags } from '../../../_lib/source_url';

export const runtime = 'nodejs';

/**
 * Walk a fact's full provenance chain. Each hop returns:
 *   - fact: the fact at that hop
 *   - source_event: the event that produced the fact
 *   - signal: the originating signal (if recoverable), with source/url/excerpt
 *
 * The signal is the leaf the human actually wants — it's the human-readable
 * "this claim came from THIS bit of text on THIS URL". We discover it via
 * events.target_kind='signal' first, falling back to events.payload.signal_id.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!id) return NextResponse.json({ error: 'fact id required' }, { status: 400 });

  const supabase = createServerClient();
  let chain;
  try {
    chain = await cite(supabase, { id });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 404 });
  }

  // Batch the per-hop reads in parallel. Each hop pulls its event + fact,
  // then resolves a signal (if any) — those three are independent of each
  // other within a hop, and hops are independent of each other.
  type SignalRow = {
    id: string;
    type: string;
    body_for_embedding: string | null;
    observed_at: string;
    structured_tags: StructuredTags | null;
  };

  const hops = await Promise.all(chain.chain.map(async (link) => {
    const [ev, factRow] = await Promise.all([
      supabase
        .from('events')
        .select('id, action, actor_kind, actor_id, target_kind, target_id, payload, prompt_hash, created_at, parent_event_id')
        .eq('id', link.source_event_id)
        .maybeSingle(),
      supabase
        .from('facts')
        .select('id, predicate, object_text, content_hash, observed_at, confidence, supersedes, signal_id')
        .eq('id', link.fact_id)
        .maybeSingle(),
    ]);

    // Resolve originating signal. Prefer the direct fact.signal_id binding
    // written at first assertion (migration 0026); fall back to the legacy
    // parent_event_id walk for facts asserted before the column existed.
    let signalRow: SignalRow | null = null;
    const factSignalId = (factRow.data as { signal_id?: string | null } | null)?.signal_id ?? null;

    if (factSignalId) {
      const sig = await supabase
        .from('signals')
        .select('id, type, body_for_embedding, observed_at, structured_tags')
        .eq('id', factSignalId)
        .maybeSingle();
      if (sig.data) signalRow = sig.data as SignalRow;
    } else {
      // Legacy fact (no signal_id). Walk the event chain up to 6 hops looking
      // for a signal target or a payload.signal_id reference.
      let cursorId: number | null = ev.data?.id ?? null;
      for (let hop = 0; hop < 6 && cursorId != null; hop++) {
        const cur = await supabase
          .from('events')
          .select('id, target_kind, target_id, payload, parent_event_id')
          .eq('id', cursorId)
          .maybeSingle();
        const e = cur.data as { id: number; target_kind: string | null; target_id: string | null; payload: Record<string, unknown> | null; parent_event_id: number | null } | null;
        if (!e) break;
        let signalId: string | null = null;
        if (e.target_kind === 'signal' && e.target_id) signalId = e.target_id;
        else if (e.payload && typeof (e.payload as Record<string, unknown>).signal_id === 'string') {
          signalId = (e.payload as Record<string, unknown>).signal_id as string;
        }
        if (signalId) {
          const sig = await supabase
            .from('signals')
            .select('id, type, body_for_embedding, observed_at, structured_tags')
            .eq('id', signalId)
            .maybeSingle();
          if (sig.data) signalRow = sig.data as SignalRow;
          break;
        }
        cursorId = e.parent_event_id;
      }
    }

    const tags = signalRow?.structured_tags ?? null;
    return {
      fact_id: link.fact_id,
      fact: factRow.data,
      source_event: ev.data,
      signal: signalRow ? {
        id: signalRow.id,
        type: signalRow.type,
        body_excerpt: signalRow.body_for_embedding?.slice(0, 280) ?? null,
        source_name: tags?.signal_source ?? null,
        source_url: pickSourceUrl(tags),
        observed_at: signalRow.observed_at,
      } : null,
    };
  }));

  return NextResponse.json({
    fact_id: id,
    fact: chain.fact,
    hops,
    hop_count: hops.length,
  });
}
