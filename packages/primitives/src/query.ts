import type { SupabaseClient } from '@supabase/supabase-js';
import { embed, vectorLiteral } from './embed.ts';
import { excludeSuperseded } from './relations.ts';
import { QueryArgsSchema, type Cite, type Projection } from './types.ts';

const TOP_K = 12;
const SIMILARITY_FLOOR = 0.55;
const RERANK_THRESHOLD = 0.75;

/**
 * NL query → projection with cites.
 *
 * Cost-aware retrieval:
 *   1. Embed the question and ANN-search facts (cheap, ~$0.0001).
 *   2. If the top score >= RERANK_THRESHOLD we return the embedding-only answer.
 *   3. Otherwise we surface the top-K facts as the projection value and let the caller
 *      decide whether to escalate to an LLM rerank (out of scope for this primitive).
 *
 * Source provenance: every match carries source meta (id / name / connector_type)
 * resolved via fact.source_event_id → events.payload.signal_id → signals.structured_tags.source_id
 * → sources. Resolution is best-effort — facts asserted out-of-band (manual,
 * scoring, drafter notes) won't have a source and that's fine. When args.source_id
 * is set, only facts whose source resolves to that id are returned.
 */
export async function query(
  supabase: SupabaseClient,
  workspace_id: string,
  args: { nl: string; perspective?: string; asker?: string; source_id?: string },
): Promise<Projection<{
  matches: Array<{
    fact_id: string;
    predicate: string;
    object_text: string | null;
    similarity: number;
    source: { source_id: string; source_name: string; connector_type: string } | null;
  }>;
  needs_rerank: boolean;
}>> {
  const v = QueryArgsSchema.parse(args);
  const embedding = await embed(v.nl);
  const vec = vectorLiteral(embedding);

  // Fact-grounded retrieval: join facts to entity_embeddings on the entity (any perspective)
  // and rank by cosine to the query embedding.
  const { data, error } = await supabase.rpc('query_facts_by_similarity', {
    p_workspace_id: workspace_id,
    p_query_embedding: vec,
    p_top_k: TOP_K,
    p_perspective: v.perspective ?? null,
  });

  if (error && error.code !== 'PGRST202' /* function not found */) throw error;

  let matches: Array<{ fact_id: string; predicate: string; object_text: string | null; similarity: number }> = [];

  if (data && Array.isArray(data)) {
    matches = data as typeof matches;
  } else {
    // Inline fallback: take all facts joined to any entity embedding within similarity floor.
    const { data: rows, error: e2 } = await supabase
      .from('facts')
      .select(`
        id, predicate, object_text, subject_entity, supersedes,
        entity_embeddings:entity_embeddings!inner(embedding)
      `)
      .eq('workspace_id', workspace_id)
      .limit(200);
    if (e2) throw e2;
    const activeRows = await excludeSuperseded(
      supabase, workspace_id,
      (rows ?? []) as Array<{ id: string; supersedes: string | null; predicate: string; object_text: string | null }>,
    );
    matches = activeRows
      .map((r) => ({
        fact_id: r.id as string,
        predicate: r.predicate as string,
        object_text: (r.object_text as string | null) ?? null,
        similarity: 0,  // similarity computed server-side once the RPC is in; placeholder for v0 fallback
      }))
      .slice(0, TOP_K);
  }

  // Resolve source per fact. Single pass, three batched joins.
  const factIds = matches.map((m) => m.fact_id);
  const sourceByFact = new Map<string, { source_id: string; source_name: string; connector_type: string; source_event_id: string }>();
  if (factIds.length) {
    const factRes = await supabase.from('facts').select('id, source_event_id').in('id', factIds);
    const facts = (factRes.data ?? []) as Array<{ id: string; source_event_id: string | null }>;
    const eventIds = [...new Set(facts.map((f) => f.source_event_id).filter((x): x is string => !!x))];
    if (eventIds.length) {
      const evRes = await supabase.from('events').select('id, payload').in('id', eventIds);
      const sigIdByEv = new Map<string, string>();
      for (const e of (evRes.data ?? []) as Array<{ id: string; payload: { signal_id?: string } | null }>) {
        const sid = e.payload?.signal_id;
        if (sid) sigIdByEv.set(String(e.id), sid);
      }
      const sigIds = [...new Set([...sigIdByEv.values()])];
      const srcIdBySig = new Map<string, string>();
      if (sigIds.length) {
        const sigRes = await supabase.from('signals').select('id, structured_tags').in('id', sigIds);
        for (const s of (sigRes.data ?? []) as Array<{ id: string; structured_tags: { source_id?: string } | null }>) {
          const src = s.structured_tags?.source_id;
          if (src) srcIdBySig.set(s.id, src);
        }
      }
      const srcMetaById = new Map<string, { source_name: string; connector_type: string }>();
      const srcIds = [...new Set([...srcIdBySig.values()])];
      if (srcIds.length) {
        const srcRes = await supabase.from('sources').select('id, name, connector_type').in('id', srcIds);
        for (const s of (srcRes.data ?? []) as Array<{ id: string; name: string; connector_type: string }>) {
          srcMetaById.set(s.id, { source_name: s.name, connector_type: s.connector_type });
        }
      }
      for (const f of facts) {
        if (!f.source_event_id) continue;
        const sigId = sigIdByEv.get(String(f.source_event_id));
        if (!sigId) continue;
        const srcId = srcIdBySig.get(sigId);
        if (!srcId) continue;
        const meta = srcMetaById.get(srcId);
        if (meta) sourceByFact.set(f.id, { source_id: srcId, ...meta, source_event_id: String(f.source_event_id) });
      }
    }
  }

  // Optional filter: keep only matches whose source resolved to the requested id.
  let filtered = matches;
  if (v.source_id) filtered = matches.filter((m) => sourceByFact.get(m.fact_id)?.source_id === v.source_id);

  const enriched = filtered.map((m) => ({
    fact_id: m.fact_id,
    predicate: m.predicate,
    object_text: m.object_text,
    similarity: m.similarity,
    source: sourceByFact.get(m.fact_id)
      ? {
          source_id: sourceByFact.get(m.fact_id)!.source_id,
          source_name: sourceByFact.get(m.fact_id)!.source_name,
          connector_type: sourceByFact.get(m.fact_id)!.connector_type,
        }
      : null,
  }));

  const cites: Cite[] = enriched
    .filter((m) => m.similarity >= SIMILARITY_FLOOR || enriched.length <= TOP_K)
    .map((m) => ({
      fact_id: m.fact_id,
      source_event_id: sourceByFact.get(m.fact_id)?.source_event_id ?? '',
    }));

  const top = enriched[0]?.similarity ?? 0;
  return {
    value: { matches: enriched, needs_rerank: top < RERANK_THRESHOLD },
    cites,
    computed_at: new Date().toISOString(),
  };
}
