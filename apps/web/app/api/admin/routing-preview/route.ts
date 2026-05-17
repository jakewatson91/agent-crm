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
  hasValueAlignedFact, loadActionContext, getPolicy,
  type ActionThresholds, type ScoreWeights, type ValueTheme,
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
  matched_theme?: string | null;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as PreviewReq | null;
  if (!body?.workspace_id) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });
  const supabase = createServerClient();
  const limit = Math.min(Math.max(body.limit ?? 30, 1), 100);

  const policy = await getPolicy(supabase, body.workspace_id);
  const thresholds: ActionThresholds = buildThresholds(body.routing ?? policy.routing);
  const weights: ScoreWeights = buildScoreWeights(body.scoring?.weights ?? policy.scoring?.weights);
  const themes = (policy.drafter?.value_themes ?? []) as ValueTheme[];

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
  const ADMIN = new Set([
    'icp_fit', 'icp_fit_breakdown', 'domain', 'contact_lookup_attempted',
    'dropped_until', 'outreach_cooldown_until', 'last_outreach_at',
    'research_triggered', 'research_completed', 'score_total',
    'no_reply_marked', 'outreach_rejected_at', 'replied_at',
    'query', 'intent', 'item_url', 'published_at', 'matched_alias',
    'topic', 'source_url', 'source_title',
  ]);
  const factsByEnt = new Map<string, Array<{ predicate: string; object_text: string | null; observed_at: string }>>();
  for (const f of (factsRes.data ?? []) as Array<{ subject_entity: string; predicate: string; object_text: string | null; observed_at: string }>) {
    const arr = factsByEnt.get(f.subject_entity) ?? [];
    arr.push({ predicate: f.predicate, object_text: f.object_text, observed_at: f.observed_at });
    factsByEnt.set(f.subject_entity, arr);
  }

  const samples: PerEntity[] = [];
  const distribution: Record<string, number> = {};

  for (const r of ranked) {
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

    // Channel + cooldown / drop info, same as production action_selector.
    const chan = await supabase.from('channels').select('id')
      .eq('workspace_id', body.workspace_id).eq('account_entity_id', r.id).maybeSingle();
    const channelCtx = chan.data?.id
      ? await loadActionContext(supabase, body.workspace_id, r.id, chan.data.id as string)
      : { recent_draft_at: null, recent_research_at: null, dropped_until: null, cooldown_until: null };

    const substantive = facts
      .filter((f) => !ADMIN.has(f.predicate) && !f.predicate.startsWith('score_'))
      .map((f) => ({ predicate: f.predicate, object_text: f.object_text }));

    const decision = selectAction({
      workspace_id: body.workspace_id,
      entity_id: r.id,
      breakdown, icp_total: icpTotal,
      recent_draft_at: channelCtx.recent_draft_at,
      recent_research_at: channelCtx.recent_research_at,
      dropped_until: channelCtx.dropped_until,
      cooldown_until: channelCtx.cooldown_until,
      facts: substantive, value_themes: themes,
      thresholds,
    });

    distribution[decision.action] = (distribution[decision.action] ?? 0) + 1;
    samples.push({
      entity_id: r.id,
      entity_name: nameById.get(r.id) ?? '?',
      icp_total_now: r.score,
      icp_total_reweighted: icpTotal,
      action: decision.action,
      policy: decision.policy,
      reason: decision.reason,
      matched_theme: (decision as { matched_theme?: string | null }).matched_theme ?? null,
    });
  }

  return NextResponse.json({
    ok: true,
    thresholds_used: thresholds,
    weights_used: weights,
    distribution,
    samples,
    sample_size: samples.length,
    matched_value_aligned: hasValueAlignedFact([], themes).aligned, // sanity: themes loaded
  });
}
