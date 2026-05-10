import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { cite } from '@agent-crm/primitives';

export const runtime = 'nodejs';

/**
 * Walk a fact's full provenance chain. Returns each hop with the source event,
 * actor, action, payload, and prompt_hash. This is what powers the cite popovers
 * in /gates and /channels — the moment a buyer realizes claims are receipted.
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

  // Hydrate each hop with the full event row so the UI can render actor/action/payload.
  const hops = [];
  for (const link of chain.chain) {
    const ev = await supabase
      .from('events')
      .select('id, action, actor_kind, actor_id, payload, prompt_hash, created_at, parent_event_id')
      .eq('id', link.source_event_id)
      .maybeSingle();
    const factRow = await supabase
      .from('facts')
      .select('id, predicate, object_text, content_hash, observed_at, confidence, supersedes')
      .eq('id', link.fact_id)
      .maybeSingle();
    hops.push({
      fact_id: link.fact_id,
      fact: factRow.data,
      source_event: ev.data,
    });
  }

  return NextResponse.json({
    fact_id: id,
    fact: chain.fact,
    hops,
    hop_count: hops.length,
  });
}
