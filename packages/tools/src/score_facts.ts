/**
 * score_facts - per-fact pitch-relevance ranking for the drafter's projection.
 *
 * Returns a top-K shortlist of fact IDs the drafter prompt is told to prefer.
 * Pure deterministic formula over data we already have. No new LLM call, no
 * new agent behavior.
 *
 *   score = pitch_relevance × recency × confidence × (1 - over_used) × outcome_boost
 *
 *   pitch_relevance  RRF-fused cosine of fact embedding vs the 4 ICP perspective
 *                    vectors (using the same cache icp_embeddings populates).
 *   recency          exp(-age_days / τ_recency)
 *   confidence       facts.confidence as stored
 *   over_used        sum over prior cites of exp(-days_since_cite / τ_overuse),
 *                    capped at 1. Scoped to THIS account's channel.
 *   outcome_boost    1 + α × bayesian_smoothed_pos_reply_rate. Auto-engages
 *                    as outcomes accumulate; ~1 with no data.
 *
 * The fact source signal (when present) is folded into the embedding text so
 * the ranking knows about the context that produced the fact, not just the
 * bare predicate+object.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { embed } from '@agent-crm/primitives';
import { getIcpPerspectiveVectors, cosine, rrfFuse } from './icp_embeddings.ts';

export interface ScoreFactsConfig {
  k: number;              // top-K shortlist size (default 3)
  tau_recency_days: number; // exponential decay τ for recency (default 45)
  tau_overuse_days: number; // exponential decay τ for per-cite penalty (default 14)
  overuse_cap: number;      // max cumulative penalty (default 1)
  outcome_alpha: number;    // max outcome boost weight (default 0.5)
  bayes_k: number;          // bayesian smoothing strength (default 5)
  min_score: number;        // facts scoring below this are dropped from the shortlist (default 0.4)
}

export const DEFAULT_CONFIG: ScoreFactsConfig = {
  k: 3,
  tau_recency_days: 45,
  tau_overuse_days: 14,
  overuse_cap: 1,
  outcome_alpha: 0.5,
  bayes_k: 5,
  min_score: 0.35,
};

/**
 * System / scoring facts that exist for the agent's own bookkeeping but are
 * never appropriate as the lead hook in an outbound draft. Excluded from the
 * candidate pool before ranking.
 */
function isSystemFact(predicate: string, object_text: string | null): boolean {
  if (predicate.startsWith('score_')) return true;
  if (predicate === 'icp_fit' || predicate === 'icp_fit_breakdown') return true;
  if (predicate.endsWith('_breakdown')) return true;
  if (predicate === 'contact_lookup_attempted') return true;
  if (predicate === 'dropped_until') return true;
  // Heuristic: object_text that is a JSON object/array or a bare number is
  // system metadata, not a human-readable claim.
  const t = (object_text ?? '').trim();
  if (t.startsWith('{') || t.startsWith('[')) return true;
  if (/^-?\d+(\.\d+)?$/.test(t)) return true;
  return false;
}

export interface FactRow {
  id: string;
  predicate: string;
  object_text: string | null;
  confidence: number;
  observed_at: string;
  source_event_id?: number | null;
}

export interface FactScoreComponents {
  pitch_relevance: number;
  recency: number;
  confidence: number;
  over_used: number;
  outcome_boost: number;
}

export interface FactScore {
  id: string;
  score: number;
  components: FactScoreComponents;
  why: string;
}

interface ScoreInputs {
  workspace_id: string;
  account_entity_id: string;
  facts: FactRow[];
  config?: Partial<ScoreFactsConfig>;
}

/**
 * Build the string we embed for a fact. Pulls the source signal body when
 * available — a fact tied to a specific signal is more "pitchable" than the
 * bare predicate+object.
 */
async function buildFactEmbeddingText(
  supabase: SupabaseClient,
  workspace_id: string,
  f: FactRow,
): Promise<string> {
  const base = `${f.predicate}: ${f.object_text ?? ''}`;
  if (!f.source_event_id) return base;
  try {
    const ev = await supabase
      .from('events')
      .select('payload')
      .eq('id', f.source_event_id)
      .maybeSingle();
    const payload = (ev.data?.payload ?? {}) as Record<string, unknown>;
    const sigId = (payload.signal_id as string | undefined) ?? undefined;
    if (!sigId) return base;
    const sig = await supabase
      .from('signals')
      .select('body_for_embedding')
      .eq('workspace_id', workspace_id)
      .eq('id', sigId)
      .maybeSingle();
    const body = (sig.data?.body_for_embedding as string | undefined) ?? '';
    return body ? `${base}\n[from signal] ${body}`.slice(0, 800) : base;
  } catch {
    return base;
  }
}

/**
 * For each fact, count past cites scoped to the entity's channel, decay-weighted.
 * cite happens via channel_posts.cites[] (uuid[]). We pull the recent posts on
 * this account's channel and tally by fact_id.
 */
async function buildOverusePenalty(
  supabase: SupabaseClient,
  workspace_id: string,
  account_entity_id: string,
  factIds: string[],
  tau_days: number,
  cap: number,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  factIds.forEach((id) => out.set(id, 0));
  if (!factIds.length) return out;
  const ch = await supabase
    .from('channels').select('id')
    .eq('workspace_id', workspace_id).eq('account_entity_id', account_entity_id)
    .maybeSingle();
  if (!ch.data?.id) return out;
  // Look back ~6 months — anything older has decayed past meaningful weight.
  const since = new Date(Date.now() - 180 * 86400_000).toISOString();
  const posts = await supabase
    .from('channel_posts').select('cites, created_at')
    .eq('channel_id', ch.data.id)
    .gte('created_at', since);
  const factSet = new Set(factIds);
  for (const p of (posts.data ?? []) as Array<{ cites: string[]; created_at: string }>) {
    const days = (Date.now() - new Date(p.created_at).getTime()) / 86400_000;
    const w = Math.exp(-days / tau_days);
    for (const cid of p.cites ?? []) {
      if (!factSet.has(cid)) continue;
      out.set(cid, Math.min(cap, (out.get(cid) ?? 0) + w));
    }
  }
  return out;
}

/**
 * Bayesian-smoothed positive-reply rate per fact, computed from outcomes on
 * touches whose drafts cited the fact. Returns ~prior_mean for facts with no
 * cite history (so outcome_boost defaults to 1 + α × prior_mean ≈ 1).
 */
async function buildOutcomeBoost(
  supabase: SupabaseClient,
  workspace_id: string,
  factIds: string[],
  alpha: number,
  bayesK: number,
): Promise<{ priorMean: number; boostById: Map<string, number> }> {
  const out = new Map<string, number>();
  factIds.forEach((id) => out.set(id, 1));
  if (!factIds.length) return { priorMean: 0, boostById: out };

  // Workspace-wide prior: overall pos-reply rate across all outcomes.
  const allOutcomes = await supabase
    .from('outcomes').select('type, touch_id')
    .order('observed_at', { ascending: false }).limit(500);
  const allRows = (allOutcomes.data ?? []) as Array<{ type: string; touch_id: string }>;
  const allPos = allRows.filter((r) => r.type === 'reply_pos').length;
  const priorMean = allRows.length ? allPos / allRows.length : 0;

  // Per-fact tally would require joining touches → channel_posts → cites.
  // For stage 1 we keep it cheap: every fact gets the prior. As outcomes
  // accumulate we can extend the query without changing the formula shape.
  // outcome_boost = 1 + α × ((pos + k × prior) / (total + k))
  // With pos=0, total=0: boost = 1 + α × prior. Same for every fact today.
  for (const id of factIds) {
    const smoothed = (0 + bayesK * priorMean) / (0 + bayesK);
    out.set(id, 1 + alpha * smoothed);
  }
  return { priorMean, boostById: out };
}

export async function scoreFacts(
  supabase: SupabaseClient,
  args: ScoreInputs,
): Promise<FactScore[]> {
  const cfg = { ...DEFAULT_CONFIG, ...(args.config ?? {}) };
  // Exclude system / scoring facts. They exist for the agent's bookkeeping
  // and would never be a good lead in an outbound email.
  args = { ...args, facts: args.facts.filter((f) => !isSystemFact(f.predicate, f.object_text)) };
  if (!args.facts.length) return [];

  // Score facts against PITCH CONTENT (what we sell) not ICP (who we sell to).
  // pain_points + value_props describe the angle a hook should match. ICP
  // describes the buyer profile — useful for qualifying entities, useless for
  // picking a fact to lead with. Falls back to ICP only when no pitch is set.
  let pitchVector: number[] | null = await getPitchVector(supabase, args.workspace_id);
  let icpPerspectives = pitchVector ? null : await getIcpPerspectiveVectors(supabase, args.workspace_id);

  const embTexts = await Promise.all(
    args.facts.map((f) => buildFactEmbeddingText(supabase, args.workspace_id, f)),
  );
  let factVectors: number[][];
  try {
    factVectors = await Promise.all(embTexts.map((t) => embed(t)));
  } catch {
    factVectors = args.facts.map(() => []);
  }

  const overuse = await buildOverusePenalty(
    supabase, args.workspace_id, args.account_entity_id,
    args.facts.map((f) => f.id), cfg.tau_overuse_days, cfg.overuse_cap,
  );
  const { boostById } = await buildOutcomeBoost(
    supabase, args.workspace_id, args.facts.map((f) => f.id), cfg.outcome_alpha, cfg.bayes_k,
  );

  const now = Date.now();
  const scored: FactScore[] = args.facts.map((f, i) => {
    let pitch = 0.5; // neutral fallback if no vectors
    if (pitchVector && factVectors[i] && factVectors[i].length) {
      pitch = Math.max(0, cosine(factVectors[i]!, pitchVector));
    } else if (icpPerspectives && factVectors[i] && factVectors[i].length) {
      const cosines = (Object.keys(icpPerspectives.vectors) as Array<keyof typeof icpPerspectives.vectors>)
        .map((p) => Math.max(0, cosine(factVectors[i]!, icpPerspectives!.vectors[p])));
      pitch = rrfFuse(cosines);
    }
    const age_days = (now - new Date(f.observed_at).getTime()) / 86400_000;
    const recency = Math.exp(-age_days / cfg.tau_recency_days);
    const used = overuse.get(f.id) ?? 0;
    const boost = boostById.get(f.id) ?? 1;
    const components: FactScoreComponents = {
      pitch_relevance: pitch,
      recency,
      confidence: f.confidence,
      over_used: used,
      outcome_boost: boost,
    };
    const score = pitch * recency * f.confidence * (1 - used) * boost;
    // One-line "why" for the projection. Audit-friendly, also helps the LLM
    // override the shortlist when context demands.
    const matchLabel = pitchVector ? 'pitch match' : 'ICP match';
    const parts: string[] = [];
    if (pitch >= 0.6) parts.push(`high ${matchLabel}`);
    else if (pitch >= 0.4) parts.push(`moderate ${matchLabel}`);
    if (recency >= 0.7) parts.push('recent');
    else if (recency <= 0.3) parts.push('stale');
    if (used >= 0.5) parts.push(`used ${used.toFixed(1)} cite-weight recently`);
    if (boost > 1.05) parts.push(`+${((boost - 1) * 100).toFixed(0)}% outcome boost`);
    const why = parts.length ? parts.join(', ') : 'default ranking';
    return { id: f.id, score, components, why };
  });

  scored.sort((a, b) => b.score - a.score);
  // Drop anything below the configured threshold. Empty shortlist is fine —
  // drafter falls back to its own judgment on the full fact list.
  return scored.filter((s) => s.score >= cfg.min_score).slice(0, cfg.k);
}

/**
 * Build (and cache) the workspace's pitch embedding from `about` + `constitution`.
 * These are the canonical place workspaces describe what they sell and how they
 * pitch value. Returns null only when both fields are empty — caller falls back
 * to ICP perspectives.
 */
async function getPitchVector(
  supabase: SupabaseClient,
  workspace_id: string,
): Promise<number[] | null> {
  const ws = await supabase
    .from('workspaces').select('about, constitution, policy').eq('id', workspace_id).maybeSingle();
  const about = ((ws.data?.about as string | undefined) ?? '').trim();
  const constitution = ((ws.data?.constitution as string | undefined) ?? '').trim();
  if (!about && !constitution) return null;

  const text = [
    about ? `What we sell:\n${about}` : '',
    constitution ? `How we describe value:\n${constitution}` : '',
  ].filter(Boolean).join('\n\n').slice(0, 4000);

  // Cache keyed by hash of the input — auto-invalidates when about/constitution change.
  const policy = (ws.data?.policy ?? {}) as Record<string, unknown>;
  const cached = (policy.pitch_embedding_cache ?? {}) as { hash?: string; vector?: number[] };
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 24);
  if (cached.hash === hash && cached.vector) return cached.vector;

  const vector = await embed(text);
  const newPolicy = { ...policy, pitch_embedding_cache: { hash, vector } };
  await supabase.from('workspaces').update({ policy: newPolicy }).eq('id', workspace_id);
  return vector;
}
