/**
 * Synthetic "what would happen" preview for routing thresholds + scoring
 * weights. Takes proposed policy values, runs selectAction against the
 * workspace's top N entities using their current sub-score facts, and
 * returns the action distribution + sample-by-sample breakdown.
 *
 * Read-only — no writes, no LLM calls. Used by Settings → Routing so the
 * customer can see whether their tuning produces more or fewer drafts
 * before saving.
 */
import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import {
  selectAction, buildThresholds, buildScoreWeights, combineSubScores,
  loadActionContext, loadBestContactScore, getPolicy,
  type ActionThresholds, type ScoreWeights,
} from '@agent-crm/tools';

export const runtime = 'nodejs';
export const maxDuration = 30;

interface PreviewReq {
  workspace_id: string;
  routing?: Parameters<typeof buildThresholds>[0];
  scoring?: { weights?: Partial<ScoreWeights>; rrf_gate?: number };
  limit?: number;
}

interface PerEntity {
  entity_id: string;
  entity_name: string;
  icp_total_now: number;
  icp_total_reweighted: number;
  action: string;
  policy: string;
  reason: string;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as PreviewReq | null;
  if (!body?.workspace_id) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });
  const supabase = createServerClient();
  const limit = Math.min(Math.max(body.limit ?? 30, 1), 100);

  const policy = await getPolicy(supabase, body.workspace_id);
  const thresholds: ActionThresholds = buildThresholds(body.routing ?? policy.routing);
  const weights: ScoreWeights = buildScoreWeights(body.scoring?.weights ?? policy.scoring?.weights);

  // Pick top-N entities by current icp_fit (cheap proxy for "what the user
  // most cares about right now"). Score facts give us the breakdown.
  const icpFacts = await supabase.from('facts')
    .select('subject_entity, object_text')
    .eq('workspace_id', body.workspace_id).eq('predicate', 'icp_fit').is('supersedes', null)
    .limit(2000);
  const ranked = ((icpFacts.data ?? []) as Array<{ subject_entity: string; object_text: string }>)
    .map((r) => ({ id: r.subject_entity, score: parseFloat(r.object_text ?? '0') }))
    .filter((x) => Number.isFinite(x.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const entIds = ranked.map((r) => r.id);
  if (!entIds.length) return NextResponse.json({ ok: true, samples: [], distribution: {} });

  // Pull entities + all active facts in one round trip each.
  const [entsRes, factsRes] = await Promise.all([
    supabase.from('entities').select('id, name').in('id', entIds),
    supabase.from('facts')
      .select('subject_entity, predicate, object_text, observed_at')
      .in('subject_entity', entIds).is('supersedes', null).limit(10000),
  ]);
  const nameById = new Map(((entsRes.data ?? []) as Array<{ id: string; name: string }>).map((e) => [e.id, e.name]));

  // Group facts per entity.
  const factsByEnt = new Map<string, Array<{ predicate: string; object_text: string | null; observed_at: string }>>();
  for (const f of (factsRes.data ?? []) as Array<{ subject_entity: string; predicate: string; object_text: string | null; observed_at: string }>) {
    const arr = factsByEnt.get(f.subject_entity) ?? [];
    arr.push({ predicate: f.predicate, object_text: f.object_text, observed_at: f.observed_at });
    factsByEnt.set(f.subject_entity, arr);
  }

  // Channel lookup batched once for every ranked entity instead of one query
  // per entity — `ranked` is capped at 100, and this was 100 round trips.
  const chansRes = await supabase.from('channels').select('id, account_entity_id')
    .eq('workspace_id', body.workspace_id).in('account_entity_id', entIds);
  const channelIdByEnt = new Map(
    ((chansRes.data ?? []) as Array<{ id: string; account_entity_id: string }>).map((c) => [c.account_entity_id, c.id]),
  );

  // Each entity's remaining lookups (cooldown/drop context, best contact
  // score) are independent of every other entity's, so run them concurrently
  // instead of one at a time.
  const samplesOrdered = await Promise.all(ranked.map(async (r) => {
    const facts = factsByEnt.get(r.id) ?? [];
    const readScore = (p: string) => {
      const f = facts.find((x) => x.predicate === p);
      const v = f ? parseFloat(f.object_text ?? '') : NaN;
      return Number.isFinite(v) ? v : 0;
    };
    const breakdown = {
      industry_match: readScore('score_industry_match'),
      stage_match: readScore('score_stage_match'),
      signal_strength: readScore('score_signal_strength'),
      evidence_depth: readScore('score_evidence_depth'),
      recency: readScore('score_recency'),
      graph_proximity: readScore('score_graph_proximity'),
      rrf_prefilter: 0,
    };
    // Recompute icp_total under the proposed weights — this is the "if you save"
    // total the customer sees in the preview.
    const icpTotal = combineSubScores(breakdown, weights);

    // Cooldown / drop info, same as production action_selector.
    const channelId = channelIdByEnt.get(r.id);
    const [channelCtx, bestContactScore] = await Promise.all([
      channelId
        ? loadActionContext(supabase, body.workspace_id, r.id, channelId)
        : Promise.resolve({ recent_draft_at: null, recent_research_at: null, recent_contacts_request_at: null, dropped_until: null, cooldown_until: null }),
      loadBestContactScore(supabase, body.workspace_id, r.id),
    ]);
    const decision = selectAction({
      workspace_id: body.workspace_id,
      entity_id: r.id,
      breakdown, icp_total: icpTotal,
      best_contact_score: bestContactScore,
      recent_draft_at: channelCtx.recent_draft_at,
      recent_research_at: channelCtx.recent_research_at,
      recent_contacts_request_at: channelCtx.recent_contacts_request_at,
      dropped_until: channelCtx.dropped_until,
      cooldown_until: channelCtx.cooldown_until,
      thresholds,
    });

    const sample: PerEntity = {
      entity_id: r.id,
      entity_name: nameById.get(r.id) ?? '?',
      icp_total_now: r.score,
      icp_total_reweighted: icpTotal,
      action: decision.action,
      policy: decision.policy,
      reason: decision.reason,
    };
    return sample;
  }));

  const samples: PerEntity[] = samplesOrdered;
  const distribution: Record<string, number> = {};
  for (const s of samples) distribution[s.action] = (distribution[s.action] ?? 0) + 1;

  return NextResponse.json({
    ok: true,
    thresholds_used: thresholds,
    weights_used: weights,
    distribution,
    samples,
    sample_size: samples.length,
  });
}
