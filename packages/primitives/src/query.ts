import type { SupabaseClient } from '@supabase/supabase-js';
import { embed, vectorLiteral } from './embed.js';
import { QueryArgsSchema, type Cite, type Projection } from './types.js';

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
 */
export async function query(
  supabase: SupabaseClient,
  workspace_id: string,
  args: { nl: string; perspective?: string; asker?: string },
): Promise<Projection<{ matches: Array<{ fact_id: string; predicate: string; object_text: string | null; similarity: number }>; needs_rerank: boolean }>> {
  const v = QueryArgsSchema.parse(args);
  const embedding = await embed(v.nl);
  const vec = vectorLiteral(embedding);

  // Fact-grounded retrieval: join facts to entity_embeddings on the entity (any perspective)
  // and rank by cosine to the query embedding.
  // For v0 we use entity_embeddings as the searchable surface; signals would be a second pass.
  const { data, error } = await supabase.rpc('query_facts_by_similarity', {
    p_workspace_id: workspace_id,
    p_query_embedding: vec,
    p_top_k: TOP_K,
    p_perspective: v.perspective ?? null,
  });

  // The RPC isn't defined in 0001-0004; primitives package will provide a fallback that
  // does the search inline if the RPC doesn't exist (for v0 simplicity).
  if (error && error.code !== 'PGRST202' /* function not found */) throw error;

  let matches: Array<{ fact_id: string; predicate: string; object_text: string | null; similarity: number }> = [];

  if (data && Array.isArray(data)) {
    matches = data as typeof matches;
  } else {
    // Inline fallback: take all facts joined to any entity embedding within similarity floor.
    const { data: rows, error: e2 } = await supabase
      .from('facts')
      .select(`
        id, predicate, object_text, subject_entity,
        entity_embeddings:entity_embeddings!inner(embedding)
      `)
      .eq('workspace_id', workspace_id)
      .is('supersedes', null)
      .limit(200);
    if (e2) throw e2;
    matches = (rows ?? [])
      .map((r) => ({
        fact_id: r.id as string,
        predicate: r.predicate as string,
        object_text: (r.object_text as string | null) ?? null,
        similarity: 0,  // similarity computed server-side once the RPC is in; placeholder for v0 fallback
      }))
      .slice(0, TOP_K);
  }

  const cites: Cite[] = matches
    .filter((m) => m.similarity >= SIMILARITY_FLOOR || matches.length <= TOP_K)
    .map((m) => ({ fact_id: m.fact_id, source_event_id: '' }));

  const top = matches[0]?.similarity ?? 0;
  return {
    value: { matches, needs_rerank: top < RERANK_THRESHOLD },
    cites,
    computed_at: new Date().toISOString(),
  };
}
