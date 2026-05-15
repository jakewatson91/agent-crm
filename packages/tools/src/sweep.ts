/**
 * sweepWorkspace - deterministic health checks across 4 tiers.
 * Used by:
 *   - scripts/sweep.ts (CLI + SessionStart hook)
 *   - system_tasks.systemHealthMonitor (hourly cron, opens gate on RED)
 *
 * No LLM calls. One round-trip per table. Returns flat array of CheckResult
 * so callers can format / threshold however they want.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';

export type Severity = 'red' | 'yellow' | 'green';
export type CheckResult = {
  id: string;
  severity: Severity;
  metric: string;
  threshold?: string;
  action?: string;
};

export const SWEEP_THRESHOLDS = {
  diversity_red: 0.50,
  diversity_yellow: 0.70,
  diversity_min_signals: 5,

  source_share_red: 0.70,
  source_share_yellow: 0.50,

  novelty_overlap_red: 0.30,
  novelty_min_signals: 5,

  cron_stale_h_red: 24,
  cron_stale_h_yellow: 12,

  cost_ratio_red: 2.0,

  score_decile_red: 0.60,
  score_decile_yellow: 0.40,
  score_min_entities: 20,

  coupling_red: 0.50,
};

const HOUR = 3600_000;
const DAY = 86_400_000;

function hashBody(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

export async function sweepWorkspace(sb: SupabaseClient, workspace_id: string): Promise<CheckResult[]> {
  const T = SWEEP_THRESHOLDS;
  const out: CheckResult[] = [];
  const now = Date.now();
  const since24 = new Date(now - DAY).toISOString();
  const since48 = new Date(now - 2 * DAY).toISOString();
  const since7d = new Date(now - 7 * DAY).toISOString();

  const sigs24 = await sb.from('signals')
    .select('id, type, structured_tags, body_for_embedding, entity_id, created_at')
    .eq('workspace_id', workspace_id).gte('created_at', since24).limit(20000);
  const signals24 = (sigs24.data ?? []) as Array<{
    id: string; type: string; structured_tags: { signal_source?: string } | null;
    body_for_embedding: string | null; entity_id: string; created_at: string;
  }>;

  const sigs48 = await sb.from('signals')
    .select('body_for_embedding')
    .eq('workspace_id', workspace_id).gte('created_at', since48).lt('created_at', since24).limit(20000);
  const signals48 = (sigs48.data ?? []) as Array<{ body_for_embedding: string | null }>;

  const metricsRes = await sb.from('events')
    .select('payload, ts')
    .eq('workspace_id', workspace_id).eq('action', 'agent_run_metrics')
    .gte('ts', since7d).limit(20000);
  const metrics = ((metricsRes.data ?? []) as Array<{
    payload: { behavior?: string; input_tokens?: number; output_tokens?: number;
               cached_input_tokens?: number; ok?: boolean; actor_id?: string } | null;
    ts: string;
  }>).filter((e) => e.payload != null);

  // TIER 1 ----------------------------------------------------

  const bySource = new Map<string, { total: number; uniqueHashes: Set<string> }>();
  for (const s of signals24) {
    const src = s.structured_tags?.signal_source ?? '(unknown)';
    const body = s.body_for_embedding ?? '';
    const rec = bySource.get(src) ?? { total: 0, uniqueHashes: new Set() };
    rec.total += 1;
    if (body) rec.uniqueHashes.add(hashBody(body));
    bySource.set(src, rec);
  }
  for (const [src, rec] of bySource) {
    if (rec.total < T.diversity_min_signals) continue;
    const ratio = rec.uniqueHashes.size / rec.total;
    const sev: Severity = ratio < T.diversity_red ? 'red' : ratio < T.diversity_yellow ? 'yellow' : 'green';
    out.push({
      id: `signal_diversity:${src}`,
      severity: sev,
      metric: `unique_ratio=${ratio.toFixed(2)} (n=${rec.total})`,
      threshold: `>= ${T.diversity_red.toFixed(2)}`,
      action: sev !== 'green' ? `inspect last 50 from source=${src} for repeated body_for_embedding` : undefined,
    });
  }

  if (bySource.size > 1 && signals24.length >= T.diversity_min_signals) {
    let maxSrc = ''; let maxShare = 0;
    for (const [src, rec] of bySource) {
      const share = rec.total / signals24.length;
      if (share > maxShare) { maxShare = share; maxSrc = src; }
    }
    const sev: Severity = maxShare > T.source_share_red ? 'red'
      : maxShare > T.source_share_yellow ? 'yellow' : 'green';
    out.push({
      id: 'source_concentration',
      severity: sev,
      metric: `${maxSrc}=${fmtPct(maxShare)} (of ${signals24.length})`,
      threshold: `< ${fmtPct(T.source_share_yellow)}`,
      action: sev !== 'green' ? `other sources silent? check sources table for last_run_status=error` : undefined,
    });
  }

  if (signals24.length >= T.novelty_min_signals && signals48.length > 0) {
    const prior = new Set<string>();
    for (const s of signals48) if (s.body_for_embedding) prior.add(hashBody(s.body_for_embedding));
    let overlap = 0; let withBody = 0;
    for (const s of signals24) {
      if (!s.body_for_embedding) continue;
      withBody += 1;
      if (prior.has(hashBody(s.body_for_embedding))) overlap += 1;
    }
    const ratio = withBody ? overlap / withBody : 0;
    const sev: Severity = ratio > T.novelty_overlap_red ? 'red' : 'green';
    out.push({
      id: 'novelty:24h_vs_prior',
      severity: sev,
      metric: `overlap=${ratio.toFixed(2)} (${overlap}/${withBody})`,
      threshold: `<= ${T.novelty_overlap_red.toFixed(2)}`,
      action: sev === 'red' ? `signals re-published from prior day - likely a re-enriching loop or stuck cursor` : undefined,
    });
  }

  // TIER 2 ----------------------------------------------------

  const enricherRuns7d = new Map<string, number[]>();
  const enricherRuns24h = new Map<string, number>();
  for (const e of metrics) {
    if (e.payload?.behavior !== 'enricher') continue;
    const actor = e.payload.actor_id ?? '(unknown)';
    const ageH = (now - new Date(e.ts).getTime()) / HOUR;
    if (ageH <= 24) enricherRuns24h.set(actor, (enricherRuns24h.get(actor) ?? 0) + 1);
    const dayBucket = Math.floor(ageH / 24);
    const arr = enricherRuns7d.get(actor) ?? new Array(7).fill(0);
    if (dayBucket >= 0 && dayBucket < 7) arr[dayBucket] += 1;
    enricherRuns7d.set(actor, arr);
  }
  for (const [actor, daily] of enricherRuns7d) {
    const med = median(daily.slice(1));
    const today = enricherRuns24h.get(actor) ?? 0;
    if (med < 1) continue;
    const sev: Severity = today === 0 ? 'red' : today < med * 0.2 ? 'yellow' : 'green';
    if (sev === 'green') continue;
    out.push({
      id: `enricher_silence:${actor}`,
      severity: sev,
      metric: `runs_24h=${today} (7d_median=${med.toFixed(1)})`,
      threshold: `>= ${(med * 0.2).toFixed(1)}`,
      action: `check agent ${actor} for error events in last 24h`,
    });
  }

  const srcRes = await sb.from('sources')
    .select('name, connector_type, active, last_run_at, last_run_status')
    .eq('workspace_id', workspace_id).eq('active', true);
  const sources = (srcRes.data ?? []) as Array<{
    name: string; connector_type: string; active: boolean;
    last_run_at: string | null; last_run_status: string | null;
  }>;
  for (const s of sources) {
    const ageH = s.last_run_at ? (now - new Date(s.last_run_at).getTime()) / HOUR : Infinity;
    const sev: Severity = ageH > T.cron_stale_h_red ? 'red'
      : ageH > T.cron_stale_h_yellow ? 'yellow' : 'green';
    if (sev === 'green') continue;
    out.push({
      id: `cron_stale:${s.name}`,
      severity: sev,
      metric: `last_run=${ageH === Infinity ? 'never' : ageH.toFixed(1) + 'h ago'}`,
      threshold: `< ${T.cron_stale_h_red}h`,
      action: `source "${s.name}" active but not running - check Inngest dashboard for ${s.connector_type}`,
    });
  }

  const byBehavior24h = new Map<string, number>();
  const byBehavior7d = new Map<string, number[]>();
  for (const e of metrics) {
    const b = e.payload?.behavior ?? '(unknown)';
    if (!e.payload?.ok) continue;
    const ageH = (now - new Date(e.ts).getTime()) / HOUR;
    if (ageH <= 24) byBehavior24h.set(b, (byBehavior24h.get(b) ?? 0) + 1);
    const dayBucket = Math.floor(ageH / 24);
    const arr = byBehavior7d.get(b) ?? new Array(7).fill(0);
    if (dayBucket >= 0 && dayBucket < 7) arr[dayBucket] += 1;
    byBehavior7d.set(b, arr);
  }
  for (const [behavior, daily] of byBehavior7d) {
    const med = median(daily.slice(1));
    const today = byBehavior24h.get(behavior) ?? 0;
    if (med < 1) continue;
    const sev: Severity = today === 0 ? 'red' : today < med * 0.3 ? 'yellow' : 'green';
    if (sev === 'green') continue;
    out.push({
      id: `agent_silence:${behavior}`,
      severity: sev,
      metric: `runs_24h=${today} (7d_median=${med.toFixed(1)})`,
      threshold: `>= ${(med * 0.3).toFixed(1)}`,
      action: `behavior=${behavior} stopped producing - check prompt returned tool calls`,
    });
  }

  // TIER 3 ----------------------------------------------------

  const dailyTokens = new Array(7).fill(0);
  for (const e of metrics) {
    const t = (e.payload?.input_tokens ?? 0) + (e.payload?.output_tokens ?? 0);
    const ageH = (now - new Date(e.ts).getTime()) / HOUR;
    const day = Math.floor(ageH / 24);
    if (day >= 0 && day < 7) dailyTokens[day] += t;
  }
  const tokens24 = dailyTokens[0];
  const tokensMedian7d = median(dailyTokens.slice(1));

  const uniqueSignals24h = new Set<string>();
  for (const s of signals24) if (s.body_for_embedding) uniqueSignals24h.add(hashBody(s.body_for_embedding));
  if (uniqueSignals24h.size > 0 && tokens24 > 0) {
    const costToday = tokens24 / uniqueSignals24h.size;
    const allRes = await sb.from('signals')
      .select('body_for_embedding, created_at')
      .eq('workspace_id', workspace_id).gte('created_at', since7d).limit(40000);
    const rows = (allRes.data ?? []) as Array<{ body_for_embedding: string | null; created_at: string }>;
    const perDay: Set<string>[] = Array.from({ length: 7 }, () => new Set());
    for (const r of rows) {
      if (!r.body_for_embedding) continue;
      const ageH = (now - new Date(r.created_at).getTime()) / HOUR;
      const d = Math.floor(ageH / 24);
      if (d >= 0 && d < 7) perDay[d]!.add(hashBody(r.body_for_embedding));
    }
    const dailyUnique = perDay.map((s) => s.size);
    const dailyCost = dailyTokens.map((t, i) => (dailyUnique[i] ? t / dailyUnique[i] : 0)).slice(1).filter((x) => x > 0);
    const medCost = median(dailyCost);
    const sev: Severity = medCost > 0 && costToday > medCost * T.cost_ratio_red ? 'red' : 'green';
    out.push({
      id: 'cost_per_unique_signal',
      severity: sev,
      metric: `${costToday.toFixed(0)} tok/sig (7d_median=${medCost.toFixed(0)})`,
      threshold: `<= ${(medCost * T.cost_ratio_red).toFixed(0)} tok/sig`,
      action: sev === 'red' ? `spend rising without new signal - check signal_diversity above` : undefined,
    });
  }

  const wsChannelsRes = await sb.from('channels').select('id').eq('workspace_id', workspace_id);
  const wsChannelIds = ((wsChannelsRes.data ?? []) as Array<{ id: string }>).map((c) => c.id);
  if (wsChannelIds.length) {
    const claimsRes = await sb.from('channel_posts')
      .select('id, created_at')
      .eq('kind', 'claim')
      .in('channel_id', wsChannelIds)
      .gte('created_at', since7d).limit(20000);
    const claims = ((claimsRes.data ?? []) as Array<{ created_at: string }>);
    const dailyClaims = new Array(7).fill(0);
    for (const c of claims) {
      const d = Math.floor((now - new Date(c.created_at).getTime()) / HOUR / 24);
      if (d >= 0 && d < 7) dailyClaims[d] += 1;
    }
    const claims24 = dailyClaims[0];
    if (claims24 > 0) {
      const costToday = tokens24 / claims24;
      const dailyCost = dailyTokens.map((t, i) => (dailyClaims[i] ? t / dailyClaims[i] : 0)).slice(1).filter((x) => x > 0);
      const medCost = median(dailyCost);
      const sev: Severity = medCost > 0 && costToday > medCost * T.cost_ratio_red ? 'red' : 'green';
      out.push({
        id: 'cost_per_claim',
        severity: sev,
        metric: `${costToday.toFixed(0)} tok/claim (7d_median=${medCost.toFixed(0)})`,
        threshold: `<= ${(medCost * T.cost_ratio_red).toFixed(0)} tok/claim`,
        action: sev === 'red' ? `claims down or spend up - check agent_silence + signal_diversity` : undefined,
      });
    } else if (tokensMedian7d > 1000) {
      out.push({
        id: 'cost_per_claim',
        severity: 'yellow',
        metric: `0 claims in 24h (spend=${tokens24} tokens)`,
        threshold: `>= 1 claim`,
        action: `agents running but posting no claims - check claim_poster behavior + threshold facts`,
      });
    }
  }

  // TIER 4 ----------------------------------------------------

  const scoreRes = await sb.from('facts')
    .select('subject_entity, object_text, observed_at')
    .eq('workspace_id', workspace_id).eq('predicate', 'icp_fit').is('supersedes', null).limit(20000);
  const scoreRows = ((scoreRes.data ?? []) as Array<{ subject_entity: string; object_text: string | null; observed_at: string }>)
    .map((r) => ({ entity: r.subject_entity, score: r.object_text ? parseFloat(r.object_text) : NaN, observed_at: r.observed_at }))
    .filter((r) => Number.isFinite(r.score));

  if (scoreRows.length >= T.score_min_entities) {
    const deciles = new Array(10).fill(0);
    for (const r of scoreRows) {
      const d = Math.min(9, Math.max(0, Math.floor(r.score * 10)));
      deciles[d] += 1;
    }
    const maxDecile = Math.max(...deciles);
    const share = maxDecile / scoreRows.length;
    const maxIdx = deciles.indexOf(maxDecile);
    const sev: Severity = share > T.score_decile_red ? 'red'
      : share > T.score_decile_yellow ? 'yellow' : 'green';
    out.push({
      id: 'score_distribution',
      severity: sev,
      metric: `${fmtPct(share)} of ${scoreRows.length} in decile ${maxIdx}/10`,
      threshold: `< ${fmtPct(T.score_decile_yellow)}`,
      action: sev !== 'green' ? `scorer collapsing values - check rubric prompt + RRF prefilter spread` : undefined,
    });
  }

  const entitiesWithNewSignals = new Set<string>();
  for (const s of signals24) entitiesWithNewSignals.add(s.entity_id);
  if (entitiesWithNewSignals.size >= 5) {
    const cutoff = new Date(now - DAY).toISOString();
    let moved = 0;
    const scoreByEntity = new Map<string, string>();
    for (const r of scoreRows) scoreByEntity.set(r.entity, r.observed_at);
    for (const eid of entitiesWithNewSignals) {
      const obs = scoreByEntity.get(eid);
      if (obs && obs >= cutoff) moved += 1;
    }
    const coupling = moved / entitiesWithNewSignals.size;
    const sev: Severity = coupling < T.coupling_red ? 'red' : 'green';
    out.push({
      id: 'score_signal_coupling',
      severity: sev,
      metric: `${moved}/${entitiesWithNewSignals.size} entities rescored after new signal (${fmtPct(coupling)})`,
      threshold: `>= ${fmtPct(T.coupling_red)}`,
      action: sev === 'red' ? `new signals not triggering rescore - check enricher to scoreAndAssert path` : undefined,
    });
  }

  return out;
}
