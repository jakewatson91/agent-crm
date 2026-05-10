import type { SupabaseClient } from '@supabase/supabase-js';
import { embed, vectorLiteral } from '@agent-crm/primitives';

/**
 * Compute and upsert a default-perspective embedding for an entity. Connectors
 * that create entities should call this so query() and any similarity-based
 * scoring works on connector-imported data, the same way seed_demo does.
 *
 * The embedded text is what an agent sees when retrieving the entity in a
 * semantic search context. Keep it dense and descriptive.
 */
export async function upsertEntityEmbedding(
  supabase: SupabaseClient,
  entity_id: string,
  embedText: string,
  perspective: string = 'default',
): Promise<void> {
  const vec = await embed(embedText);
  const { error } = await supabase
    .from('entity_embeddings')
    .upsert({
      entity_id,
      perspective,
      embedding: vectorLiteral(vec) as unknown as string,
    });
  if (error) throw new Error(`upsertEntityEmbedding failed: ${error.message}`);
}
