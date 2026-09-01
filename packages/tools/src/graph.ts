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
  /**
   * How many of those neighbors actually carried an icp_fit, i.e. how many fed
   * the mean. This is the one the caller must test before treating `score` as a
   * verdict: `edge_count` counts neighbors we cannot score either.
   *
   * A contact is the case that matters. Its only edge is works_at -> account,
   * and contacts store `contact_score`, never `icp_fit` (see scoring.ts), so an
   * account whose sole link is a contact has edge_count 1 and nothing to
   * average. Reading `score` there says "its connections are a terrible fit"
   * when the truth is "we have no scored connections yet". Live case: Wedotv
   * gained a contact scoring 0.77 and its icp_fit fell 0.94 -> 0.81, because a
   * fabricated 0.00 joined the weighted mean at 10% of the weight and diluted
   * every other dimension.
   */
  scored_neighbor_count: number;
  predicates: Record<string, number>; // counts per predicate, for audit
  /** The edge facts + neighbor icp_fit facts that actually fed the mean, for citing the score. */
  evidence_fact_ids: string[];
}

/** Live, superseded-free graph rows for one entity, however they were fetched. */
export interface GraphEdges {
  subj_edges: Array<{ id: string; predicate: string; object_entity: string }>;
  obj_edges: Array<{ id: string; predicate: string; subject_entity: string }>;
  fits: Array<{ id: string; subject_entity: string; object_text: string }>;
}

/**
 * For the given entity, find every other entity it's linked to via one of the
 * edge predicates (in either direction — both `subject` and `object_entity`).
 * Look up each neighbor's latest `icp_fit` fact. Return the mean.
 *
 * Five requests. scoreEntity does not use this path: it gets the same rows in
 * the one bundle score_inputs() returns and calls graphProximityFrom directly.
 * This stays for callers holding nothing but an entity id.
 */
export async function graphProximity(
  supabase: SupabaseClient,
  workspace_id: string,
  entity_id: string,
): Promise<GraphProximityResult> {
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

  const neighborIds = [...new Set([
    ...subjEdges.map((e) => e.object_entity),
    ...objEdges.map((e) => e.subject_entity),
  ])];
  let fits: Array<{ id: string; subject_entity: string; object_text: string; supersedes: string | null }> = [];
  if (neighborIds.length) {
    // 3. Look up latest icp_fit for each neighbor.
    const fitsRes = await supabase
      .from('facts')
      .select('id, subject_entity, object_text, supersedes')
      .eq('workspace_id', workspace_id)
      .eq('predicate', 'icp_fit')
      .in('subject_entity', neighborIds);
    fits = await excludeSuperseded(supabase, workspace_id,
      (fitsRes.data ?? []) as Array<{ id: string; subject_entity: string; object_text: string; supersedes: string | null }>);
  }
  return graphProximityFrom({ subj_edges: subjEdges, obj_edges: objEdges, fits });
}

/**
 * The arithmetic, over rows someone else already fetched. Subject edges are
 * walked before object edges and the first edge per neighbour wins, because
 * `predicates` counts one edge per neighbour and which one it names depends on
 * that order.
 */
export function graphProximityFrom(edges: GraphEdges): GraphProximityResult {
  const empty: GraphProximityResult = { score: 0, edge_count: 0, scored_neighbor_count: 0, predicates: {}, evidence_fact_ids: [] };
  const subjEdges = edges.subj_edges ?? [];
  const objEdges = edges.obj_edges ?? [];
  const fits = edges.fits ?? [];

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

  // Neighbors exist but none of them is scored, so there is nothing to average.
  // scored_neighbor_count 0 is what tells the caller this is a gap in what we
  // know rather than a mean that came out at zero.
  if (fitValues.length === 0) {
    return { score: 0, edge_count: neighbors.size, scored_neighbor_count: 0, predicates, evidence_fact_ids: [] };
  }

  const mean = fitValues.reduce((a, b) => a + b, 0) / fitValues.length;
  return {
    score: Math.max(0, Math.min(1, mean)),
    edge_count: neighbors.size,
    scored_neighbor_count: fitValues.length,
    predicates,
    evidence_fact_ids: evidenceFactIds,
  };
}
