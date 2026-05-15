/**
 * Graph features over the entity ↔ fact graph.
 *
 * Production fit-scoring at companies like Clearbit / ZoomInfo / Apollo uses
 * variants of "their customers are your customers" as one of the strongest
 * signals. We have the substrate to do this directly: the same `customer_of`,
 * `partners_with`, `backed_by`, `integrates_with` predicates the enricher
 * already asserts form an explicit edge graph, with provenance, that we can
 * traverse in plain SQL.
 *
 * No GNN needed at our scale (<300 entities). The 1-hop neighborhood mean of
 * `icp_fit` over linked entities captures most of the signal a graph model
 * would learn.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

const EDGE_PREDICATES = [
  'customer_of',
  'partners_with',
  'backed_by',
  'integrates_with',
  'invested_by',
] as const;

export interface GraphProximityResult {
  score: number;        // [0, 1] — mean icp_fit of linked entities, 0 if no edges
  edge_count: number;   // how many neighbors were found
  predicates: Record<string, number>; // counts per predicate, for audit
}

/**
 * For the given entity, find every other entity it's linked to via one of the
 * edge predicates (in either direction — both `subject` and `object_entity`).
 * Look up each neighbor's latest `icp_fit` fact. Return the mean.
 */
export async function graphProximity(
  supabase: SupabaseClient,
  workspace_id: string,
  entity_id: string,
): Promise<GraphProximityResult> {
  const empty: GraphProximityResult = { score: 0, edge_count: 0, predicates: {} };

  // 1. Edges where this entity is the subject: facts(subject=entity_id, predicate∈EDGES, object_entity!=null)
  const subjEdges = await supabase
    .from('facts')
    .select('predicate, object_entity')
    .eq('workspace_id', workspace_id)
    .eq('subject_entity', entity_id)
    .in('predicate', EDGE_PREDICATES as unknown as string[])
    .is('supersedes', null)
    .not('object_entity', 'is', null);

  // 2. Edges where this entity is the object: facts(object_entity=entity_id, predicate∈EDGES)
  const objEdges = await supabase
    .from('facts')
    .select('predicate, subject_entity')
    .eq('workspace_id', workspace_id)
    .eq('object_entity', entity_id)
    .in('predicate', EDGE_PREDICATES as unknown as string[])
    .is('supersedes', null);

  const neighbors = new Map<string, string>();  // entity_id -> predicate that linked it
  const predicates: Record<string, number> = {};
  for (const e of (subjEdges.data ?? []) as Array<{ predicate: string; object_entity: string }>) {
    if (!neighbors.has(e.object_entity)) {
      neighbors.set(e.object_entity, e.predicate);
      predicates[e.predicate] = (predicates[e.predicate] ?? 0) + 1;
    }
  }
  for (const e of (objEdges.data ?? []) as Array<{ predicate: string; subject_entity: string }>) {
    if (!neighbors.has(e.subject_entity)) {
      neighbors.set(e.subject_entity, e.predicate);
      predicates[e.predicate] = (predicates[e.predicate] ?? 0) + 1;
    }
  }

  if (neighbors.size === 0) return empty;

  // 3. Look up latest icp_fit for each neighbor.
  const neighborIds = [...neighbors.keys()];
  const fits = await supabase
    .from('facts')
    .select('subject_entity, object_text')
    .eq('workspace_id', workspace_id)
    .eq('predicate', 'icp_fit')
    .is('supersedes', null)
    .in('subject_entity', neighborIds);

  const fitValues: number[] = [];
  for (const f of (fits.data ?? []) as Array<{ subject_entity: string; object_text: string }>) {
    const v = parseFloat(f.object_text);
    if (!isNaN(v)) fitValues.push(v);
  }

  if (fitValues.length === 0) return { score: 0, edge_count: neighbors.size, predicates };

  const mean = fitValues.reduce((a, b) => a + b, 0) / fitValues.length;
  return { score: Math.max(0, Math.min(1, mean)), edge_count: neighbors.size, predicates };
}
