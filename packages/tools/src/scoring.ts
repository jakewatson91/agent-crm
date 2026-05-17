/**
 * Scoring v2 — multi-dimensional rubric, graph features, RRF pre-filter.
 *
 * Pipeline:
 *   1. Load entity + facts + workspace ICP/about.
 *   2. Compute deterministic sub-scores: evidence_depth, recency, graph_proximity.
 *   3. Build entity perspective embeddings (pain/stack/vertical) from facts.
 *      Cosine each against the cached ICP perspectives, fuse via RRF.
 *   4. If the RRF pre-filter is < 0.3, skip the LLM entirely — return a low
 *      score with reasoning, save the call.
 *   5. Otherwise call the LLM rubric: industry_match, stage_match, signal_strength.
 *   6. Combine into icp_total via a transparent weighted-sum formula.
 *   7. Assert every sub-score as its own fact for audit + future calibration.
 *
 * Backward compat: keeps writing `icp_fit` = icp_total as the rolling total
 * fact, so the drafter prompt and UI badges that read `icp_fit` keep working.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { chatComplete, embed } from '@agent-crm/primitives';
import { act } from '@agent-crm/primitives';
import { graphProximity } from './graph.js';
import { getIcpPerspectiveVectors, cosine, rrfFuse, type Perspective } from './icp_embeddings.js';

const SCORE_MODEL = 'deepseek/deepseek-v4-flash:free';
const RRF_GATE = 0.3;           // below this, skip LLM
const RECENCY_TAU_DAYS = 45;    // exponential decay constant

// Predicates that don't count as "substantive" evidence for evidence_depth.
const ADMIN_PREDICATES = new Set([
  'icp_fit',
  'icp_fit_breakdown',
  'domain',
  'contact_lookup_attempted',
  'dropped_until',
  'score_industry_match',
  'score_stage_match',
  'score_evidence_depth',
  'score_signal_strength',
  'score_recency',
  'score_graph_proximity',
  'score_total',
]);

export interface ScoreBreakdown {
  industry_match: number;
  stage_match: number;
  signal_strength: number;
  evidence_depth: number;
  recency: number;
  graph_proximity: number;
  rrf_prefilter: number;
}

export interface EntityScore {
  icp_fit: number;              // alias of icp_total, kept for backward compat
  icp_total: number;
  breakdown: ScoreBreakdown;
  reasoning: string;
  llm_called: boolean;          // false if RRF pre-filter shortcut fired
}

// ---------- helpers ----------

function clamp01(x: number): number { return Math.max(0, Math.min(1, x)); }

function evidenceDepth(facts: Array<{ predicate: string }>): number {
  const substantive = facts.filter((f) => !ADMIN_PREDICATES.has(f.predicate)).length;
  // 6 substantive facts = full depth. Linear up to that.
  return clamp01(substantive / 6);
}

function recencyScore(facts: Array<{ created_at?: string; observed_at?: string }>): number {
  if (!facts.length) return 0;
  let mostRecent = 0;
  for (const f of facts) {
    const t = Date.parse(f.observed_at ?? f.created_at ?? '');
    if (Number.isFinite(t) && t > mostRecent) mostRecent = t;
  }
  if (!mostRecent) return 0;
  const ageDays = (Date.now() - mostRecent) / 86400_000;
  return clamp01(Math.exp(-ageDays / RECENCY_TAU_DAYS));
}

function buildEntityPerspectiveText(
  entityName: string,
  entityAttributes: Record<string, unknown>,
  facts: Array<{ predicate: string; object_text: string | null }>,
): Record<Perspective, string> {
  const factLines = facts
    .filter((f) => !ADMIN_PREDICATES.has(f.predicate))
    .map((f) => `${f.predicate}=${f.object_text ?? ''}`)
    .join('\n');
  const attrStr = JSON.stringify(entityAttributes ?? {});

  // Group facts by perspective. Cheap keyword-based routing into buckets.
  // Imperfect — that's what the embedding model is for. We just need the text
  // weighted toward the right concepts.
  const painKeywords = /(pain|problem|need|gap|frustrat|burn|leak|cost|losing|complain)/i;
  const stackKeywords = /(stack|uses|integrat|build|deployed|platform|tool|technology|api|framework|language|database|infra)/i;
  const verticalKeywords = /(industry|vertical|market|segment|customer|target|sells_to|serves|category|sector)/i;

  const painLines = facts.filter((f) => painKeywords.test(f.predicate + ' ' + (f.object_text ?? ''))).map((f) => `${f.predicate}=${f.object_text}`).join('\n');
  const stackLines = facts.filter((f) => stackKeywords.test(f.predicate + ' ' + (f.object_text ?? ''))).map((f) => `${f.predicate}=${f.object_text}`).join('\n');
  const verticalLines = facts.filter((f) => verticalKeywords.test(f.predicate + ' ' + (f.object_text ?? ''))).map((f) => `${f.predicate}=${f.object_text}`).join('\n');

  return {
    default: `${entityName}\nAttributes: ${attrStr}\nFacts:\n${factLines}`.slice(0, 1500),
    pain: `${entityName} — pains and problems they face:\n${painLines || factLines}`.slice(0, 1500),
    stack: `${entityName} — technology stack and integrations:\n${stackLines || attrStr}`.slice(0, 1500),
    vertical: `${entityName} — industry and target market:\n${verticalLines || attrStr}`.slice(0, 1500),
  };
}

// ---------- main scoring ----------

export async function scoreEntity(
  supabase: SupabaseClient,
  workspace_id: string,
  entity_id: string,
): Promise<EntityScore | null> {
  const [entRes, factsRes, wsRes, graphRes, icpVecs] = await Promise.all([
    supabase.from('entities').select('id, name, kind, attributes').eq('id', entity_id).maybeSingle(),
    supabase.from('facts').select('predicate, object_text, confidence, observed_at, created_at')
      .eq('workspace_id', workspace_id).eq('subject_entity', entity_id)
      .is('supersedes', null).order('observed_at', { ascending: false }).limit(40),
    supabase.from('workspaces').select('icp, about, persona').eq('id', workspace_id).maybeSingle(),
    graphProximity(supabase, workspace_id, entity_id),
    getIcpPerspectiveVectors(supabase, workspace_id),
  ]);

  if (!entRes.data) return null;
  const entity = entRes.data as { name: string; kind: string; attributes: Record<string, unknown> };
  const facts = (factsRes.data ?? []) as Array<{ predicate: string; object_text: string | null; confidence: number; observed_at: string; created_at: string }>;
  const ws = (wsRes.data ?? {}) as { icp?: Record<string, unknown>; about?: string; persona?: Record<string, unknown> };

  // Skip-when-stale guard: if a prior score_total exists and no substantive
  // fact is newer than it, the score can't have changed — bail before the
  // LLM + 4 embedding calls. Defense-in-depth; callers should already gate
  // on whether new facts were asserted this tick.
  const scoreTotalFact = facts.find((f) => f.predicate === 'score_total');
  if (scoreTotalFact) {
    const scoreTs = Date.parse(scoreTotalFact.observed_at ?? scoreTotalFact.created_at ?? '');
    const hasNewerSubstantive = facts.some((f) =>
      !ADMIN_PREDICATES.has(f.predicate) &&
      Date.parse(f.observed_at ?? f.created_at ?? '') > scoreTs,
    );
    if (!hasNewerSubstantive) return null;
  }

  // ---- Deterministic sub-scores ----
  const evidence_depth = evidenceDepth(facts);
  const recency = recencyScore(facts);
  const graph = graphRes.score;

  // ---- RRF pre-filter via multi-perspective embeddings ----
  let rrf_prefilter = 0;
  if (icpVecs) {
    const perspectiveText = buildEntityPerspectiveText(entity.name, entity.attributes ?? {}, facts);
    // Embed all 4 perspectives for the entity. If this fails for any reason
    // (network, model), we fall through to the LLM rubric — no graceful
    // degradation needed beyond logging.
    let entityVecs: Record<Perspective, number[]> | null = null;
    try {
      const [defV, painV, stackV, vertV] = await Promise.all([
        embed(perspectiveText.default),
        embed(perspectiveText.pain),
        embed(perspectiveText.stack),
        embed(perspectiveText.vertical),
      ]);
      entityVecs = { default: defV, pain: painV, stack: stackV, vertical: vertV };
    } catch { /* leave entityVecs null; pre-filter contributes 0 */ }

    if (entityVecs) {
      const sims = [
        cosine(entityVecs.pain, icpVecs.vectors.pain),
        cosine(entityVecs.stack, icpVecs.vectors.stack),
        cosine(entityVecs.vertical, icpVecs.vectors.vertical),
      ];
      rrf_prefilter = rrfFuse(sims);
    }
  }

  // ---- Pre-filter shortcut: when 3 embedding perspectives unanimously
  //      disagree with the ICP, more facts won't flip the answer. Skip the
  //      LLM call regardless of evidence depth.
  if (rrf_prefilter < RRF_GATE) {
    const breakdown: ScoreBreakdown = {
      industry_match: clamp01(rrf_prefilter),
      stage_match: 0,
      signal_strength: 0,
      evidence_depth,
      recency,
      graph_proximity: graph,
      rrf_prefilter,
    };
    const icp_total = combineSubScores(breakdown);
    return {
      icp_total,
      icp_fit: icp_total,
      breakdown,
      reasoning: `Pre-filter shortcut: multi-perspective cosine ${rrf_prefilter.toFixed(2)} is below the LLM-rubric gate and evidence is thin. No LLM call.`,
      llm_called: false,
    };
  }

  // ---- LLM rubric: industry_match, stage_match, signal_strength ----
  const sysPrompt = `You score how well an account fits the workspace's ICP. You are NOT producing a single overall score; you are producing three orthogonal sub-scores on a strict rubric.

Each sub-score is in [0.0, 1.0]. Be calibrated: do not inflate scores.

DIMENSIONS:
1. industry_match — does the entity's industry / market positioning match the ICP industries described in the workspace ABOUT and ICP? Match the prose, not a single keyword.
   - 1.0: textbook match (their industry literally matches what the workspace targets)
   - 0.7: strong adjacency (close vertical, related use case)
   - 0.4: tangential (might apply, no direct fit)
   - 0.0: clear mismatch (different industry / wrong market)

2. stage_match — funding/team/scale alignment.
   - 1.0: stage maps perfectly to ICP (e.g. early-stage as required, right team size)
   - 0.7: close but slightly off (e.g. one stage early or late)
   - 0.4: ambiguous — could be either
   - 0.0: wrong scale (e.g. ICP wants startups, this is a 10k-person enterprise)

3. signal_strength — how *actionable* is the most recent signal that triggered this scoring?
   IMPORTANT: a directory listing or a generic mention is NOT a strong signal. Strong signals are:
   - 1.0: hiring for the specific role we sell to, fundraising announcement, public pain statement matching our pitch, mentioning a competitor we displace
   - 0.7: clear growth signal (new round, leadership hire, customer launch)
   - 0.4: passive presence (active on a directory, listed in a database)
   - 0.0: noise (mentioned in passing in unrelated content)

REASONING: 1–2 sentences citing the SPECIFIC facts that drove each score. No filler. No template phrases.

Output JSON only:
{"industry_match": 0.0-1.0, "stage_match": 0.0-1.0, "signal_strength": 0.0-1.0, "reasoning": "<1-2 sentences>"}`;

  const userPrompt = `WORKSPACE ABOUT:
${(ws.about ?? '').slice(0, 800)}

WORKSPACE ICP:
${JSON.stringify(ws.icp ?? {}, null, 2)}

ACCOUNT: ${entity.name} (${entity.kind})

ATTRIBUTES:
${JSON.stringify(entity.attributes ?? {}, null, 2)}

FACTS (predicate=value, conf):
${facts.length ? facts.filter((f) => !ADMIN_PREDICATES.has(f.predicate)).map((f) => `  ${f.predicate}=${f.object_text} (${f.confidence})`).join('\n') : '  (none)'}

PRE-COMPUTED SIGNALS (for context, not to copy):
  evidence_depth=${evidence_depth.toFixed(2)} (deterministic — count of substantive facts)
  recency=${recency.toFixed(2)} (deterministic — exponential decay on most recent fact)
  graph_proximity=${graph.toFixed(2)} (deterministic — mean icp_fit of linked entities)
  rrf_prefilter=${rrf_prefilter.toFixed(2)} (deterministic — multi-perspective cosine vs ICP)

Score this account on the three rubric dimensions.`;

  let parsed: { industry_match?: number; stage_match?: number; signal_strength?: number; reasoning?: string };
  try {
    const llm = await chatComplete({
      model: SCORE_MODEL,
      max_tokens: 350,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: userPrompt },
      ],
    });
    parsed = JSON.parse(llm.text);
  } catch {
    return null;
  }

  const breakdown: ScoreBreakdown = {
    industry_match: clamp01(typeof parsed.industry_match === 'number' ? parsed.industry_match : 0),
    stage_match: clamp01(typeof parsed.stage_match === 'number' ? parsed.stage_match : 0),
    signal_strength: clamp01(typeof parsed.signal_strength === 'number' ? parsed.signal_strength : 0),
    evidence_depth,
    recency,
    graph_proximity: graph,
    rrf_prefilter,
  };

  const icp_total = combineSubScores(breakdown);
  return {
    icp_total,
    icp_fit: icp_total,
    breakdown,
    reasoning: (parsed.reasoning ?? '').toString().slice(0, 400),
    llm_called: true,
  };
}

/**
 * The combine formula is exposed publicly so the UI / audit tools can show
 * the math instead of just the final number.
 */
export function combineSubScores(b: ScoreBreakdown): number {
  const total =
    0.30 * b.industry_match +
    0.20 * b.stage_match +
    0.20 * b.evidence_depth +
    0.10 * b.signal_strength +
    0.10 * b.recency +
    0.10 * b.graph_proximity;
  return clamp01(total);
}

// ---------- assertion ----------

export async function scoreAndAssert(
  supabase: SupabaseClient,
  actor: { workspace_id: string; actor_kind: 'agent' | 'user' | 'system'; actor_id: string },
  entity_id: string,
): Promise<EntityScore | null> {
  // Respect active dropped_until: re-scoring a dropped entity wastes LLM calls,
  // pollutes the score_distribution sweep, and gives the operator a fresh
  // score that contradicts the drop decision. action_selector already
  // short-circuits at the action layer; this is the same check, earlier.
  const dropRes = await supabase.from('facts')
    .select('object_text')
    .eq('workspace_id', actor.workspace_id)
    .eq('subject_entity', entity_id)
    .eq('predicate', 'dropped_until')
    .is('supersedes', null)
    .order('observed_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const dropUntil = (dropRes.data?.object_text as string | null) ?? null;
  if (dropUntil) {
    const t = Date.parse(dropUntil);
    if (Number.isFinite(t) && t > Date.now()) return null;
  }

  const score = await scoreEntity(supabase, actor.workspace_id, entity_id);
  if (!score) return null;

  // Sub-scores asserted as their own facts for audit + future calibration.
  // Each one supersedes the prior version. We do this in a loop so a write
  // failure on one doesn't abort the rest.
  const subScores: Array<{ predicate: string; value: number }> = [
    { predicate: 'score_industry_match', value: score.breakdown.industry_match },
    { predicate: 'score_stage_match', value: score.breakdown.stage_match },
    { predicate: 'score_signal_strength', value: score.breakdown.signal_strength },
    { predicate: 'score_evidence_depth', value: score.breakdown.evidence_depth },
    { predicate: 'score_recency', value: score.breakdown.recency },
    { predicate: 'score_graph_proximity', value: score.breakdown.graph_proximity },
    { predicate: 'score_total', value: score.icp_total },
    { predicate: 'icp_fit', value: score.icp_total }, // backward compat
  ];
  for (const s of subScores) {
    // Use order+limit+maybeSingle instead of plain maybeSingle: if a prior
    // run left duplicate active rows (>1 with supersedes=null), maybeSingle
    // alone errors and falls into the "no existing" branch, which writes
    // ANOTHER active row — compounding the leak. Picking the newest by
    // observed_at lets us still supersede something instead of inserting.
    const existing = await supabase.from('facts').select('id, object_text')
      .eq('workspace_id', actor.workspace_id)
      .eq('subject_entity', entity_id)
      .eq('predicate', s.predicate)
      .is('supersedes', null)
      .order('observed_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const newText = s.value.toFixed(2);
    if (existing.data?.object_text === newText) continue; // unchanged; skip write
    try {
      if (existing.data) {
        await act(supabase, actor, {
          tool: 'supersede_fact',
          args: {
            subject_entity: entity_id, predicate: s.predicate,
            object_text: newText, confidence: 0.9,
            supersedes: existing.data.id,
          },
        });
      } else {
        await act(supabase, actor, {
          tool: 'assert_fact',
          args: { subject_entity: entity_id, predicate: s.predicate, object_text: newText, confidence: 0.9 },
        });
      }
    } catch {
      // skip; next rescore tick retries
    }
  }

  // Breakdown JSON as a separate fact for human / UI consumption.
  try {
    await act(supabase, actor, {
      tool: 'assert_fact',
      args: {
        subject_entity: entity_id, predicate: 'icp_fit_breakdown',
        object_text: JSON.stringify(score.breakdown), confidence: 0.85,
      },
    });
  } catch { /* non-fatal */ }

  return score;
}
