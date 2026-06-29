/**
 * Compute and cache the workspace ICP embeddings across 4 perspectives:
 * default, pain, stack, vertical. Used by scoring v2's RRF pre-filter to
 * decide if an entity is even worth running through the LLM rubric.
 *
 * The ICP description (workspaces.icp + workspaces.about) is stable per
 * workspace, so we hash the input and cache the resulting vector in
 * workspaces.embedding_cache.icp_embedding_cache — keyed by hash so a stale
 * cache auto-invalidates when ICP/about changes. Stored in its own column
 * (not policy) so policy stays small on the hot read path.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { embed } from '@agent-crm/primitives';

export type Perspective = 'default' | 'pain' | 'stack' | 'vertical';

export interface IcpPerspectiveVectors {
  hash: string;                          // hash of inputs the cache is keyed by
  vectors: Record<Perspective, number[]>;
}

function inputHash(about: string, icp: Record<string, unknown>): string {
  const blob = `${about.trim()}\n---\n${JSON.stringify(icp ?? {})}`;
  return createHash('sha256').update(blob).digest('hex').slice(0, 24);
}

/**
 * Build the 4 perspective strings deterministically from workspace.icp + about.
 * No LLM call needed — we just slice the ICP description differently per
 * perspective. The embedding model handles the rest.
 */
function buildPerspectiveStrings(about: string, icp: Record<string, unknown>): Record<Perspective, string> {
  const icpStr = JSON.stringify(icp ?? {}, null, 2);
  const aboutStr = (about ?? '').trim();
  return {
    default: `${aboutStr}\n\nICP:\n${icpStr}`.slice(0, 1500),
    pain: `Operational pain this company solves for its customers. From: ${aboutStr}`.slice(0, 1500),
    stack: `Technology stack and integrations this company looks for in customers. ICP: ${icpStr}`.slice(0, 1500),
    vertical: `Industries and verticals this company sells to. ICP: ${icpStr}`.slice(0, 1500),
  };
}

/**
 * In-process memo so a scoring batch (many scoreEntity calls in one process)
 * reads the ~75 KB perspective-vector cache from the DB once, not once per
 * entity. TTL bounds staleness if ICP/about changes mid-run. This is the bulk
 * of the egress fix for the per-entity path; the DB column move only stops
 * policy reads from carrying the vectors.
 */
const VEC_MEMO_TTL_MS = 5 * 60_000;
const icpVecMemo = new Map<string, { at: number; value: IcpPerspectiveVectors | null }>();

/**
 * Get cached perspective vectors for the workspace, computing + storing if
 * the cache is missing or the input hash changed.
 */
export async function getIcpPerspectiveVectors(
  supabase: SupabaseClient,
  workspace_id: string,
): Promise<IcpPerspectiveVectors | null> {
  const memo = icpVecMemo.get(workspace_id);
  if (memo && Date.now() - memo.at < VEC_MEMO_TTL_MS) return memo.value;

  const ws = await supabase
    .from('workspaces')
    .select('icp, about, embedding_cache')
    .eq('id', workspace_id)
    .maybeSingle();
  if (!ws.data) {
    icpVecMemo.set(workspace_id, { at: Date.now(), value: null });
    return null;
  }

  const about = (ws.data.about as string) ?? '';
  const icp = (ws.data.icp as Record<string, unknown>) ?? {};
  const cache = (ws.data.embedding_cache as Record<string, unknown>) ?? {};
  const hash = inputHash(about, icp);

  const cached = (cache.icp_embedding_cache as { hash?: string; vectors?: Record<Perspective, number[]> } | undefined);
  if (cached?.hash === hash && cached.vectors) {
    const value = { hash, vectors: cached.vectors };
    icpVecMemo.set(workspace_id, { at: Date.now(), value });
    return value;
  }

  // Recompute all 4 perspectives in parallel.
  const strings = buildPerspectiveStrings(about, icp);
  const [defaultV, painV, stackV, verticalV] = await Promise.all([
    embed(strings.default),
    embed(strings.pain),
    embed(strings.stack),
    embed(strings.vertical),
  ]);
  const vectors: Record<Perspective, number[]> = {
    default: defaultV,
    pain: painV,
    stack: stackV,
    vertical: verticalV,
  };

  // Persist back to workspaces.embedding_cache.icp_embedding_cache. Kept out
  // of policy so the ~9 hot paths that `select policy` don't drag these vectors
  // over the wire on every read.
  const newCache = { ...cache, icp_embedding_cache: { hash, vectors } };
  await supabase
    .from('workspaces')
    .update({ embedding_cache: newCache })
    .eq('id', workspace_id);

  const value = { hash, vectors };
  icpVecMemo.set(workspace_id, { at: Date.now(), value });
  return value;
}

/**
 * Cosine similarity between two equal-length vectors.
 * Both vectors are assumed pre-normalized by OpenAI's embedding API; we still
 * normalize defensively because pgvector storage round-trips can drift.
 */
export function cosine(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Reciprocal Rank Fusion (Cormack, Clarke, Buettcher SIGIR 2009).
 * Given N similarity scores from different perspectives, treat each as
 * defining a ranking over candidates, then fuse. For a single candidate
 * (one entity) the "rank" is computed against itself, so we use a simpler
 * formulation: RRF over the score-ordered list of perspectives, with the
 * top-scoring perspective getting the most weight.
 *
 * Returns a value in [0, 1] suitable as a direct signal. k is the standard
 * RRF smoothing constant; 60 is the commonly cited value from the paper.
 */
export function rrfFuse(scores: number[], k: number = 60): number {
  if (!scores.length) return 0;
  const sorted = [...scores].sort((a, b) => b - a);
  let fused = 0;
  for (let i = 0; i < sorted.length; i++) {
    // rank-based contribution scaled by the actual score so a poor #1 doesn't
    // dominate over a strong #2.
    fused += (sorted[i]! * 1.0) / (k + i + 1);
  }
  // Normalize against the theoretical max (all 1.0s) so output ∈ [0, 1].
  let maxPossible = 0;
  for (let i = 0; i < sorted.length; i++) maxPossible += 1.0 / (k + i + 1);
  return Math.max(0, Math.min(1, fused / maxPossible));
}
