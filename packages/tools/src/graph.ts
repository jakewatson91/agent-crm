/**
 * Graph features over the entity ↔ fact graph.
 *
 * Production fit-scoring at companies like Clearbit / ZoomInfo / Apollo uses
 * variants of "their customers are your customers" as one of the strongest
 * signals. We do this directly: any relationship edge the enricher asserts (any
 * fact whose object is another entity) forms an explicit, open graph, with
 * provenance, that we traverse in plain SQL. The vocabulary is not fixed — an
 * edge is any fact with object_entity set, whatever the relationship is named.
 *
 * No GNN needed at our scale. The 1-hop neighborhood mean of `icp_fit` over
 * linked entities captures most of the signal a graph model would learn. The
 * icp_fit lookup naturally limits the mean to scored (account) neighbors, so a
 * non-fit edge like works_at contributes nothing.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { excludeSuperseded } from '@agent-crm/primitives';

export interface GraphProximityResult {
  score: number;        // [0, 1] — mean icp_fit of linked entities, 0 if no edges
  edge_count: number;   // how many neighbors were found
  predicates: Record<string, number>; // counts per predicate, for audit
  /** The edge facts + neighbor icp_fit facts that actually fed the mean, for citing the score. */
  evidence_fact_ids: string[];
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
  const empty: GraphProximityResult = { score: 0, edge_count: 0, predicates: {}, evidence_fact_ids: [] };

  // 1. Edges where this entity is the subject: facts(subject=entity_id, predicate∈EDGES, object_entity!=null)
  const subjRes = await supabase
    .from('facts')
    .select('id, predicate, object_entity, supersedes')
    .eq('workspace_id', workspace_id)
    .eq('subject_entity', entity_id)
    .not('object_entity', 'is', null);
  const subjEdges = await excludeSuperseded(supabase, workspace_id,
    (subjRes.data ?? []) as Array<{ id: string; predicate: string; object_entity: string; supersedes: string | null }>);

  // 2. Edges where this entity is the object: facts(object_entity=entity_id, predicate∈EDGES)
  const objRes = await supabase
    .from('facts')
    .select('id, predicate, subject_entity, supersedes')
    .eq('workspace_id', workspace_id)
    .eq('object_entity', entity_id);
  const objEdges = await excludeSuperseded(supabase, workspace_id,
    (objRes.data ?? []) as Array<{ id: string; predicate: string; subject_entity: string; supersedes: string | null }>);

  const neighbors = new Map<string, { predicate: string; edge_fact_id: string }>();
  const predicates: Record<string, number> = {};
  for (const e of subjEdges) {
    if (!neighbors.has(e.object_entity)) {
      neighbors.set(e.object_entity, { predicate: e.predicate, edge_fact_id: e.id });
      predicates[e.predicate] = (predicates[e.predicate] ?? 0) + 1;
    }
  }
  for (const e of objEdges) {
    if (!neighbors.has(e.subject_entity)) {
      neighbors.set(e.subject_entity, { predicate: e.predicate, edge_fact_id: e.id });
      predicates[e.predicate] = (predicates[e.predicate] ?? 0) + 1;
    }
  }

  if (neighbors.size === 0) return empty;

  // 3. Look up latest icp_fit for each neighbor.
  const neighborIds = [...neighbors.keys()];
  const fitsRes = await supabase
    .from('facts')
    .select('id, subject_entity, object_text, supersedes')
    .eq('workspace_id', workspace_id)
    .eq('predicate', 'icp_fit')
    .in('subject_entity', neighborIds);
  const fits = await excludeSuperseded(supabase, workspace_id,
    (fitsRes.data ?? []) as Array<{ id: string; subject_entity: string; object_text: string; supersedes: string | null }>);

  const fitValues: number[] = [];
  const evidenceFactIds: string[] = [];
  for (const f of fits) {
    const v = parseFloat(f.object_text);
    if (isNaN(v)) continue;
    fitValues.push(v);
    evidenceFactIds.push(f.id);
    const edge = neighbors.get(f.subject_entity);
    if (edge) evidenceFactIds.push(edge.edge_fact_id);
  }

  if (fitValues.length === 0) return { score: 0, edge_count: neighbors.size, predicates, evidence_fact_ids: [] };

  const mean = fitValues.reduce((a, b) => a + b, 0) / fitValues.length;
  return { score: Math.max(0, Math.min(1, mean)), edge_count: neighbors.size, predicates, evidence_fact_ids: evidenceFactIds };
}
