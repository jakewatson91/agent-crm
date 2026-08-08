/**
 * sweepWorkspace - deterministic health checks across 4 tiers.
 * Used by:
 *   - scripts/sweep.ts (CLI + SessionStart hook) — the on-demand health surface
 *
 * No LLM calls. One round-trip per table. Returns flat array of CheckResult
 * so callers can format / threshold however they want.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { cronToMinIntervalMinutes } from './cron.ts';
import { getSourceMetrics } from './source_metrics.ts';
import { fetchAll } from './paginate.ts';
import { ACTIVITY_MARKERS } from './activity_markers.ts';
import { ADMIN_PREDICATES } from './scoring.ts';

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

  // Stale = ageH exceeds expected interval × this multiplier. Set high enough
  // to absorb cron jitter + one missed tick. Quarterly sources don't trip
  // until weeks past schedule.
  cron_stale_red_mult: 3.0,
  cron_stale_yellow_mult: 1.5,

  cost_ratio_red: 2.0,

  // Share of agent runs in 24h that died in the LLM call — a provider error, a
  // bad model id, a rate limit, or output truncated into unparseable JSON. Any
  // of these silently shrinks fact and draft volume, so the bar is low: a
  // twentieth of runs failing is already worth a look, a fifth is a fault.
  llm_failure_share_yellow: 0.05,
  llm_failure_share_red: 0.20,
  llm_min_runs: 10,

  score_decile_red: 0.60,
  score_decile_yellow: 0.40,
  score_min_entities: 20,

  coupling_red: 0.50,

  // Per-source dead-weight: source has produced >= N signals in 7d but the
  // enricher has extracted 0 facts from any of them. Either the matcher
  // can't link the signals to entities, or no subscription's embedding caught
  // them, or the enricher saw them and found nothing worth recording.
  // Whichever it is, the source is spending its budget for no return.
  dead_weight_min_signals: 5,

  // Contact-pull health. A recent batch of contacts_completed audit facts that's
  // mostly errors means the provider is broken (bad key / quota). Pending
  // enrich_contacts requests with no pull at all in the stall window mean
  // draining stopped (loop down or disabled) — not just a slow backlog.
  contact_error_share_red: 0.50,
  contact_min_completions: 3,
  contact_stall_hours: 48,
  // How far back to look for enrich_contacts requests when deciding whether any
  // are still pending. A request older than this is a backlog question, not a
  // "did draining stop today" question.
  contact_request_lookback_days: 90,
};

const HOUR = 3600_000;
const DAY = 86_400_000;

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

  // body_hash (md5 generated column) replaces body_for_embedding fetches — 32 bytes
  // vs ~2KB per signal. See migration 0043.
  const signals24 = await fetchAll<{
    id: string; type: string; structured_tags: { signal_source?: string } | null;
    body_hash: string | null; entity_id: string; created_at: string;
  }>((f, t) => sb.from('signals')
    .select('id, type, structured_tags, body_hash, entity_id, created_at')
    .eq('workspace_id', workspace_id).gte('created_at', since24)
    .order('created_at', { ascending: false }).range(f, t));

  const signals48 = await fetchAll<{ body_hash: string | null }>((f, t) => sb.from('signals')
    .select('body_hash')
    .eq('workspace_id', workspace_id).gte('created_at', since48).lt('created_at', since24)
    .order('created_at', { ascending: false }).range(f, t));

  const metrics = (await fetchAll<{
    payload: { behavior?: string; input_tokens?: number; output_tokens?: number;
               cached_input_tokens?: number; ok?: boolean; actor_id?: string } | null;
    ts: string;
  }>((f, t) => sb.from('events')
    .select('payload, ts:created_at')
    .eq('workspace_id', workspace_id).eq('action', 'agent_run_metrics')
    .gte('created_at', since7d).order('created_at', { ascending: false }).range(f, t)))
    .filter((e) => e.payload != null);

  // TIER 1 ----------------------------------------------------

  const bySource = new Map<string, { total: number; uniqueHashes: Set<string> }>();
  for (const s of signals24) {
    const src = s.structured_tags?.signal_source ?? '(unknown)';
    const rec = bySource.get(src) ?? { total: 0, uniqueHashes: new Set() };
    rec.total += 1;
    if (s.body_hash) rec.uniqueHashes.add(s.body_hash);
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

  // Concentration asks "is one external source feeding everything?". The
  // research loop's own output (signal_source='research', research.ts) is
  // internal fan-out triggered per-entity, not a discovery source — with few
  // active connectors it dominates the denominator and pins this check red.
  const externalSources = [...bySource.entries()].filter(([src]) => src !== 'research');
  const externalTotal = externalSources.reduce((n, [, rec]) => n + rec.total, 0);
  if (externalSources.length > 1 && externalTotal >= T.diversity_min_signals) {
    let maxSrc = ''; let maxShare = 0;
    for (const [src, rec] of externalSources) {
      const share = rec.total / externalTotal;
      if (share > maxShare) { maxShare = share; maxSrc = src; }
    }
    const sev: Severity = maxShare > T.source_share_red ? 'red'
      : maxShare > T.source_share_yellow ? 'yellow' : 'green';
    out.push({
      id: 'source_concentration',
      severity: sev,
      metric: `${maxSrc}=${fmtPct(maxShare)} (of ${externalTotal} external)`,
      threshold: `< ${fmtPct(T.source_share_yellow)}`,
      action: sev !== 'green' ? `other sources silent? check sources table for last_run_status=error` : undefined,
    });
  }

  if (signals24.length >= T.novelty_min_signals && signals48.length > 0) {
    const prior = new Set<string>();
    for (const s of signals48) if (s.body_hash) prior.add(s.body_hash);
    let overlap = 0; let withBody = 0;
    for (const s of signals24) {
      if (!s.body_hash) continue;
      withBody += 1;
      if (prior.has(s.body_hash)) overlap += 1;
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
    .select('name, connector_type, active, schedule_cron, last_run_at, last_run_status')
    .eq('workspace_id', workspace_id).eq('active', true);
  const sources = (srcRes.data ?? []) as Array<{
    name: string; connector_type: string; active: boolean; schedule_cron: string | null;
    last_run_at: string | null; last_run_status: string | null;
  }>;
  for (const s of sources) {
    const ageH = s.last_run_at ? (now - new Date(s.last_run_at).getTime()) / HOUR : Infinity;
    const expectedH = cronToMinIntervalMinutes(s.schedule_cron) / 60;
    const sev: Severity = ageH > expectedH * T.cron_stale_red_mult ? 'red'
      : ageH > expectedH * T.cron_stale_yellow_mult ? 'yellow' : 'green';
    if (sev === 'green') continue;
    out.push({
      id: `cron_stale:${s.name}`,
      severity: sev,
      metric: `last_run=${ageH === Infinity ? 'never' : ageH.toFixed(1) + 'h ago'}`,
      threshold: `expected every ${expectedH.toFixed(1)}h (cron=${s.schedule_cron ?? '-'})`,
      action: `source "${s.name}" overdue vs declared cadence — check Inngest dashboard for ${s.connector_type}`,
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
  for (const s of signals24) if (s.body_hash) uniqueSignals24h.add(s.body_hash);
  if (uniqueSignals24h.size > 0 && tokens24 > 0) {
    const costToday = tokens24 / uniqueSignals24h.size;
    // count_daily_unique_signals RPC returns 7 rows (one per day) instead of
    // fetching full signal bodies for the 7d window (~8MB). See migration 0043.
    const aggRes = await sb.rpc('count_daily_unique_signals', {
      p_workspace_id: workspace_id,
      p_since: since7d,
    });
    const dailyUnique = new Array(7).fill(0);
    for (const r of (aggRes.data ?? []) as Array<{ day_offset: number; unique_count: number }>) {
      if (r.day_offset >= 0 && r.day_offset < 7) dailyUnique[r.day_offset] = Number(r.unique_count);
    }
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

  {
    // Scope via the channels FK, not .in(channel_ids): this workspace has >1000
    // channels, so a 1000-id .in() list both caps at the first 1000 and 400s once
    // combined with order+range. The embedded channels!inner filter joins straight
    // to workspace_id and scales past 1000.
    const claims = await fetchAll<{ created_at: string }>((f, t) => sb.from('channel_posts')
      .select('id, created_at, channels!inner(workspace_id)')
      .eq('kind', 'claim')
      .eq('channels.workspace_id', workspace_id)
      .gte('created_at', since7d).order('created_at', { ascending: false }).range(f, t));
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

  // Current icp_fit per entity = the row with the LATEST observed_at, exactly as
  // the coupling check below computes it. Do NOT filter on `.is('supersedes',
  // null)`: that returns the ORIGINAL of a superseded chain (a new score points
  // BACK at the one it replaces, so the original keeps supersedes null). Every
  // entity scored more than once would be measured at its first-ever score, and
  // on a workspace that rescores daily this check would report the shape of a
  // months-old book. Same root cause as the false RED the coupling check was
  // fixed for.
  //
  // latest_facts_before (migration 0051) does the DISTINCT ON in Postgres. The
  // client-side version pulled EVERY icp_fit row ever written for the workspace —
  // ~2,400 of them land in a single day — to keep one per entity.
  const icpRows = await fetchAll<{ subject_entity: string; object_text: string | null; observed_at: string }>((f, t) =>
    sb.rpc('latest_facts_before', { p_workspace_id: workspace_id, p_predicate: 'icp_fit' }).range(f, t));
  let scoreRows = icpRows
    .map((r) => ({ entity: r.subject_entity, score: r.object_text ? parseFloat(r.object_text) : NaN, observed_at: r.observed_at }))
    .filter((r) => Number.isFinite(r.score));

  // Exclude entities with zero substantive facts. They land at score=0 by design
  // (no evidence + RRF prefilter floor), and including them in the distribution
  // makes the scorer look like it's collapsing values when it's actually behaving
  // correctly on brand-new entities. Same for dropped entities — they're frozen
  // at their last score and shouldn't pollute the live shape either.
  if (scoreRows.length) {
    // One grouped read (migration 0052) instead of paging every live fact in the
    // workspace back to count them here — ~33,000 rows on a live workspace, at
    // every session start. The entity list goes in the RPC body, so it also
    // sidesteps the PostgREST 16KB URL-header limit that a `.in()` of this many
    // UUIDs used to blow (UND_ERR_HEADERS_OVERFLOW at a 18.8KB URL).
    //
    // ADMIN_PREDICATES travels as a parameter so isSubstantiveFact stays the one
    // definition of "real evidence" — see the note in migration 0052.
    const flags = await fetchAll<{ subject_entity: string; substantive_facts: number; dropped: boolean }>((f, t) =>
      sb.rpc('entity_evidence_flags', {
        p_workspace_id: workspace_id,
        p_admin_predicates: [...ADMIN_PREDICATES],
        p_entities: scoreRows.map((r) => r.entity),
      }).range(f, t));
    const flagOf = new Map(flags.map((f) => [f.subject_entity, f]));
    scoreRows = scoreRows.filter((r) => {
      const f = flagOf.get(r.entity);
      return !!f && !f.dropped && Number(f.substantive_facts) >= 1;
    });
  }

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

  // Coupling measures the exact thing it was built to catch: when the enricher
  // extracts a genuinely NEW fact for an entity, does its score refresh? The
  // denominator is the enricher's own fact-bearing dispatches (facts_asserted>0)
  // — NOT "any new signal" (dominated by hiring posts the filters intentionally
  // skip → 0 new facts → correctly no rescore) nor "any new fact" (includes
  // contact-entity facts that don't drive account icp_fit). Re-asserts of known
  // facts return facts_asserted=0, so they don't inflate the denominator.
  const cutoff = new Date(now - DAY).toISOString();
  const dispatches = await fetchAll<{ target_id: string | null; payload: { facts_asserted?: number } | null }>((f, t) => sb.from('events')
    .select('target_id, payload')
    .eq('workspace_id', workspace_id).eq('action', 'agent_dispatch_result').gte('created_at', cutoff)
    .order('id').range(f, t));
  const entitiesWithNewFacts = new Set<string>();
  for (const d of dispatches) if ((d.payload?.facts_asserted ?? 0) > 0 && d.target_id) entitiesWithNewFacts.add(d.target_id);
  if (entitiesWithNewFacts.size >= 5) {
    // Current icp_fit per entity — the row with the LATEST observed_at. A rescore
    // always writes a newer observed_at than the version it supersedes, so the max
    // is the current score. (Reading the chain head via supersedes=null gives the
    // ORIGINAL instead, which is what made this check report rescores that DID run
    // as if they never happened — a false RED.) One RPC over the fact-bearing
    // entities; the old loop fetched every historical version of each in batches.
    const newFactIds = [...entitiesWithNewFacts];
    const latestIcp = new Map<string, string>();
    const icpNow = await fetchAll<{ subject_entity: string; observed_at: string }>((f, t) =>
      sb.rpc('latest_facts_before', {
        p_workspace_id: workspace_id, p_predicate: 'icp_fit', p_entities: newFactIds,
      }).range(f, t));
    for (const r of icpNow) latestIcp.set(r.subject_entity, r.observed_at);
    let moved = 0;
    for (const eid of entitiesWithNewFacts) {
      const obs = latestIcp.get(eid);
      if (obs && obs >= cutoff) moved += 1;
    }
    const coupling = moved / entitiesWithNewFacts.size;
    const sev: Severity = coupling < T.coupling_red ? 'red' : 'green';
    out.push({
      id: 'score_signal_coupling',
      severity: sev,
      metric: `${moved}/${entitiesWithNewFacts.size} entities rescored after new facts (${fmtPct(coupling)})`,
      threshold: `>= ${fmtPct(T.coupling_red)}`,
      action: sev === 'red' ? `new facts not triggering rescore - check enricher to scoreAndAssert path` : undefined,
    });
  }

  // Per-source dead-weight (7d window). One YELLOW per offending source —
  // operator can decide which to drop or rewrite. No auto-action here; the
  // mutation belongs in the L2 introspection loop.
  //
  // Guarded on the presence of any agent_dispatch_result events: this event is
  // what fact_yield reads from, and it was added late. Before the first
  // enricher run emits one, every source would look dead. Skip until we have
  // signal — better to be silent than to flag everything.
  try {
    const dispatchProbe = await sb.from('events')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspace_id)
      .eq('action', 'agent_dispatch_result')
      .gte('created_at', since7d);
    const dispatchCount = dispatchProbe.count ?? 0;
    if (dispatchCount > 0) {
      const metrics7d = await getSourceMetrics(sb, workspace_id, 24 * 7, { skipEntitySeeded: true });
      for (const m of metrics7d) {
        if (!m.active) continue;
        if (m.signals < T.dead_weight_min_signals) continue;
        if (m.fact_yield > 0) continue;
        out.push({
          id: `source_dead_weight:${m.name}`,
          severity: 'yellow',
          metric: `signals_7d=${m.signals}  fact_yield=0  agent_fire=${(m.agent_fire_rate * 100).toFixed(0)}%`,
          threshold: `fact_yield > 0 when signals_7d >= ${T.dead_weight_min_signals}`,
          action: `source "${m.name}" is firing but producing no facts — rewrite query, add a matching subscription, or drop`,
        });
      }
    }
  } catch (e) {
    // Non-fatal: sweep should still return the other checks even if metrics fail.
    console.error('source_dead_weight check failed:', (e as Error)?.message ?? e);
  }

  // Contact-pull health. Surfaces a silently-broken provider or a stalled drain
  // so a backlog of enrich_contacts requests doesn't sit forever — or quietly
  // start adding junk. Reads the contacts_completed event-log markers the pull
  // writes on every attempt, plus the contacts_requested markers that gate it.
  try {
    const [reqRows, compRows] = await Promise.all([
      fetchAll<{ target_id: string | null; created_at: string }>((f, t) => sb.from('events')
        .select('target_id, created_at')
        .eq('workspace_id', workspace_id).eq('target_kind', 'entity')
        .eq('action', ACTIVITY_MARKERS.CONTACTS_REQUESTED)
        // Bounded: this read had no time filter, so every sweep pulled the entire
        // request history and grew a little slower every day. The check asks
        // "has draining stopped", which a recent window answers just as well.
        .gte('created_at', new Date(now - T.contact_request_lookback_days * DAY).toISOString())
        .order('created_at', { ascending: true }).range(f, t)),
      fetchAll<{ target_id: string | null; payload: { summary?: string } | null; created_at: string }>((f, t) => sb.from('events')
        .select('target_id, payload, created_at')
        .eq('workspace_id', workspace_id).eq('target_kind', 'entity')
        .eq('action', ACTIVITY_MARKERS.CONTACTS_COMPLETED)
        .gte('created_at', since7d)
        .order('created_at', { ascending: true }).range(f, t)),
    ]);
    const requestedAt = new Map<string, number>();
    for (const r of reqRows) {
      if (!r.target_id) continue;
      requestedAt.set(r.target_id, Math.max(requestedAt.get(r.target_id) ?? 0, Date.parse(r.created_at)));
    }
    // Normalize to the shape the checks below use: { entity, summary, created_at }.
    const comps = compRows.map((c) => ({ subject_entity: c.target_id ?? '', summary: c.payload?.summary ?? '', created_at: c.created_at }));
    const completedAt = new Map<string, number>();
    for (const c of comps) {
      if (!c.subject_entity) continue;
      completedAt.set(c.subject_entity, Math.max(completedAt.get(c.subject_entity) ?? 0, Date.parse(c.created_at)));
    }

    // (a) Provider-error share over the last 24h of completions. A clean "found
    //     nobody" or "no domain" is not an error — only key/quota/HTTP failures.
    const recent = comps.filter((c) => Date.parse(c.created_at) >= now - DAY);
    const errRe = /not set|error|\b401\b|\b403\b|\b429\b|quota|insufficient|unauthor/i;
    const errs = recent.filter((c) => errRe.test(c.summary)).length;
    if (recent.length >= T.contact_min_completions) {
      const share = errs / recent.length;
      if (share >= T.contact_error_share_red) {
        out.push({
          id: 'contact_pull_errors',
          severity: 'red',
          metric: `${errs}/${recent.length} contact pulls errored in 24h (${fmtPct(share)})`,
          threshold: `< ${fmtPct(T.contact_error_share_red)}`,
          action: `contact provider failing — check EXPLORIUM_API_KEY / HUNTER_API_KEY and provider quota`,
        });
      }
    }

    // (a2) LLM failures. agentRun records `agent_llm_failed` when the model call
    //      throws (provider error / bad model id / rate limit / credit wall) or
    //      returns JSON it can't parse (almost always truncation). Measured
    //      against the runs that DID complete, so this reads as "share of agent
    //      work lost in the model call" rather than a raw count that scales with
    //      volume. Both failure modes used to return silently, which is how a
    //      broken model looked like a quiet pipeline.
    const llmFails = await fetchAll<{ payload: { reason?: string; behavior?: string; model?: string } | null }>((f, t) => sb.from('events')
      .select('payload')
      .eq('workspace_id', workspace_id).eq('action', 'agent_llm_failed')
      .gte('created_at', new Date(now - DAY).toISOString()).order('id').range(f, t));
    // Successful runs are only ever a denominator here, so count them server-side
    // instead of paging every row back (a busy day is thousands of them).
    const llmOk = await sb.from('events')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspace_id).eq('action', 'agent_run_metrics')
      .gte('created_at', new Date(now - DAY).toISOString());
    const totalRuns = llmFails.length + (llmOk.count ?? 0);
    if (totalRuns >= T.llm_min_runs && llmFails.length > 0) {
      const share = llmFails.length / totalRuns;
      const sev: Severity = share >= T.llm_failure_share_red ? 'red'
        : share >= T.llm_failure_share_yellow ? 'yellow' : 'green';
      if (sev !== 'green') {
        const byReason = new Map<string, number>();
        for (const f of llmFails) byReason.set(f.payload?.reason ?? 'unknown', (byReason.get(f.payload?.reason ?? 'unknown') ?? 0) + 1);
        const detail = [...byReason.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r}=${n}`).join(' ');
        const truncating = (byReason.get('unparseable_json') ?? 0) > 0;
        out.push({
          id: 'llm_failures',
          severity: sev,
          metric: `${llmFails.length}/${totalRuns} agent runs failed in the LLM call (${fmtPct(share)}) — ${detail}`,
          threshold: `< ${fmtPct(T.llm_failure_share_yellow)}`,
          action: truncating
            ? `model output is being truncated — compare output_tokens vs max_tokens on the agent_llm_failed events and raise the budget`
            : `model call failing — check the provider key, the configured model id, and remaining credit`,
        });
      }
    }

    // (b) Stalled drain: requests pending but not a single pull ran in the stall
    //     window. A slow capped backlog still lands completions nightly, so this
    //     only fires when draining truly stops (loop down / cap set to 0).
    const pendingCount = [...requestedAt].filter(([ent, reqT]) => (completedAt.get(ent) ?? 0) < reqT).length;
    const ranInWindow = comps.some((c) => Date.parse(c.created_at) >= now - T.contact_stall_hours * HOUR);
    if (pendingCount > 0 && !ranInWindow) {
      out.push({
        id: 'contact_pull_stalled',
        severity: 'yellow',
        metric: `${pendingCount} enrich_contacts request(s) pending, 0 pulls ran in ${T.contact_stall_hours}h`,
        threshold: `>= 1 pull / ${T.contact_stall_hours}h while pending`,
        action: `contact draining stopped — confirm the daily loop ran and enrichment.max_contact_pulls_per_run > 0`,
      });
    }
  } catch (e) {
    console.error('contact_pull check failed:', (e as Error)?.message ?? e);
  }

  // Research-loop health. The runner writes research_triggered / research_completed
  // (with results_created) / research_error markers. Exa ran out of credits once
  // and every search 402'd for 7 days with zero visibility — the runs "completed"
  // with 0 results, nothing paused, nothing alarmed. RED when the pipeline is
  // paused for research, or when the loop is dispatching but yielding nothing
  // and mostly erroring.
  try {
    const pipeRes = await sb.from('workspaces').select('policy').eq('id', workspace_id).maybeSingle();
    const pipe = (pipeRes.data?.policy as { pipeline?: { state?: string; scope?: string; reason?: string; provider?: string } } | null)?.pipeline;
    if (pipe?.state === 'paused' && (pipe.scope ?? 'all') !== 'contacts') {
      // provider set = a credit/auth wall tripped it (incident, act now);
      // no provider = a deliberate operator pause (reminder, not an alarm).
      out.push({
        id: 'pipeline_paused',
        severity: pipe.provider ? 'red' : 'yellow',
        metric: `pipeline paused (scope=${pipe.scope ?? 'all'}${pipe.provider ? `, provider=${pipe.provider}` : ', manual'})`,
        threshold: 'not paused',
        action: pipe.reason ?? 'pipeline paused — fix the provider, then click Continue',
      });
    } else {
      const rRows = await fetchAll<{ action: string; payload: { results_created?: number; message?: string } | null }>((f, t) => sb.from('events')
        .select('action, payload')
        .eq('workspace_id', workspace_id)
        .in('action', [ACTIVITY_MARKERS.RESEARCH_TRIGGERED, ACTIVITY_MARKERS.RESEARCH_COMPLETED, ACTIVITY_MARKERS.RESEARCH_ERROR])
        .gte('created_at', since48)
        .order('created_at', { ascending: true }).range(f, t));
      const triggered = rRows.filter((r) => r.action === ACTIVITY_MARKERS.RESEARCH_TRIGGERED).length;
      const errors = rRows.filter((r) => r.action === ACTIVITY_MARKERS.RESEARCH_ERROR);
      const results = rRows
        .filter((r) => r.action === ACTIVITY_MARKERS.RESEARCH_COMPLETED)
        .reduce((n, r) => n + (r.payload?.results_created ?? 0), 0);
      if (triggered >= 5 && results === 0 && errors.length >= triggered / 2) {
        const firstErr = errors[0]?.payload?.message?.slice(0, 100) ?? 'unknown';
        out.push({
          id: 'research_yield',
          severity: 'red',
          metric: `${triggered} research runs in 48h, 0 results, ${errors.length} errors`,
          threshold: 'results > 0 when the dispatcher is firing',
          action: `research is running but producing nothing — first error: ${firstErr}`,
        });
      }
    }
  } catch (e) {
    console.error('research health check failed:', (e as Error)?.message ?? e);
  }

  return out;
}
