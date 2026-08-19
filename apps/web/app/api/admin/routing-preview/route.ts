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
  selectAction, buildThresholds, buildScoreWeights, combineSubScores, breakdownFromFacts,
  loadActionContext, loadBestContactScore, getPolicy, fetchAll, pickAnchorCandidates,
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
  //
  // Two things were wrong with this read, and they cancelled out into a preview
  // that looked plausible. It stopped at PostgREST's 1000 rows out of 2,000-odd
  // scored accounts, so "top N" was the top N of an arbitrary half. And
  // `.is('supersedes', null)` does not mean current: the row nothing points at
  // is the ORIGINAL, so a rescored account was ranked on the score it was given
  // the first time it was ever seen. Take every icp_fit fact and drop the ones
  // something supersedes, which is the walk advance_accounts and the drafter
  // dry run already use.
  const icpFacts = await fetchAll<{ id: string; subject_entity: string; object_text: string; supersedes: string | null }>((from, to) =>
    supabase.from('facts')
      .select('id, subject_entity, object_text, supersedes')
      .eq('workspace_id', body.workspace_id).eq('predicate', 'icp_fit')
      .order('id').range(from, to));
  const superseded = new Set(icpFacts.map((r) => r.supersedes).filter(Boolean));
  const ranked = icpFacts
    .filter((r) => !superseded.has(r.id))
    .map((r) => ({ id: r.subject_entity, score: parseFloat(r.object_text ?? '0') }))
    .filter((x) => Number.isFinite(x.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const entIds = ranked.map((r) => r.id);
  if (!entIds.length) return NextResponse.json({ ok: true, samples: [], distribution: {} });

  // Pull entities + all active facts in one round trip each. `limit` is capped
  // by the caller, so entIds is a short list, but the facts hanging off it are
  // not: .limit(10000) was another 1000 in practice, which for a breakdown
  // panel means the accounts at the bottom of the sample silently lose their
  // sub-scores and preview as though they had none.
  const [entsRes, factRows] = await Promise.all([
    supabase.from('entities').select('id, name').in('id', entIds),
    fetchAll<{ id: string; subject_entity: string; predicate: string; object_text: string | null; observed_at: string; happened_at: string | null; supersedes: string | null }>((from, to) =>
      supabase.from('facts')
        .select('id, subject_entity, predicate, object_text, observed_at, happened_at, supersedes')
        .in('subject_entity', entIds).order('id').range(from, to)),
  ]);
  const nameById = new Map(((entsRes.data ?? []) as Array<{ id: string; name: string }>).map((e) => [e.id, e.name]));

  // Group facts per entity. Same current-fact walk as the ranking above.
  const pointedAt = new Set(factRows.map((f) => f.supersedes).filter(Boolean));
  const factsByEnt = new Map<string, Array<{ predicate: string; object_text: string | null; observed_at: string }>>();
  // Whether each account has a dated reason to write. The preview has to run the
  // same test production runs, or it answers a question nobody asked: this is the
  // condition that decides whether a draft happens, and it is no longer a
  // threshold anyone can tune on this page.
  const anchorByEnt = new Map<string, boolean>();
  const liveFacts = factRows.filter((r) => !pointedAt.has(r.id));
  for (const f of liveFacts) {
    const arr = factsByEnt.get(f.subject_entity) ?? [];
    arr.push({ predicate: f.predicate, object_text: f.object_text, observed_at: f.observed_at });
    factsByEnt.set(f.subject_entity, arr);
  }
  for (const [entId, _] of factsByEnt) {
    const hits = pickAnchorCandidates({
      facts: liveFacts.filter((f) => f.subject_entity === entId)
        .map((f) => ({ id: f.id, predicate: f.predicate, object_text: f.object_text, happened_at: f.happened_at })),
      freshDays: policy.drafter?.trigger_fresh_days,
    });
    anchorByEnt.set(entId, hits.candidates.length > 0);
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
    // Read through breakdownFromFacts, which keeps unknown_dims. Rebuilding the
    // breakdown from the score_* rows alone drops it, and combineSubScores then
    // averages in the placeholder 0 those rows store for a dimension nobody
    // could measure. The preview would price the proposed weights against a
    // total production never computes: on the Sudden book 811 of 861 accounts
    // have at least one unmeasured dimension.
    const breakdown = breakdownFromFacts(facts)?.breakdown ?? {
      industry_match: 0, stage_match: 0, signal_strength: 0,
      evidence_depth: 0, recency: 0, graph_proximity: 0, rrf_prefilter: 0,
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
      has_anchor: anchorByEnt.get(r.id) ?? false,
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
