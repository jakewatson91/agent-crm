/**
 * Source curator (L2). Reads L1 per-source metrics, picks candidate sources
 * for mutation, calls an LLM to decide what to do, and (optionally) applies
 * the mutation through the existing tool layer so every change lands as an
 * event with prior_state in the payload — making undo a one-line read.
 *
 * Not a registered agent. A scheduled job that calls existing tools. The
 * LLM call is deterministic-shape JSON, not function-calling.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSourceMetrics, type SourceMetric } from './source_metrics.ts';
import { chatCompleteForWorkspace } from './chat_workspace.ts';
import { callTool } from './index.ts';

export type CuratorAction =
  | 'deactivate'
  | 'rewrite_query'
  | 'add_catchall_subscription'
  | 'no_action';

export interface CuratorDecision {
  source_id: string;
  source_name: string;
  action: CuratorAction;
  reasoning: string;
  // Action-specific payload — only set when action requires it.
  new_query?: string;
  new_subscription_semantic?: string;
  // For audit + smoke logging.
  metrics_snapshot: { signals_7d: number; signals_14d: number; agent_fire_rate_7d: number; fact_yield_7d: number };
}

export interface CurateOpts {
  apply?: boolean;            // default false — dryrun returns decisions only
  max_candidates?: number;    // default 5
  max_apply?: number;         // default 3 per run
  cooldown_days?: number;     // default 7 — skip sources mutated recently
}

const ACTOR_ID = 'source_curator';
const CURATOR_MODEL = 'deepseek-v4-flash';
const SAMPLE_SIGNALS = 5;
/** How far back a sample may come from. Also what bounds the scan for a dead source. */
const SAMPLE_WINDOW_DAYS = 30;
const MIN_SIGNALS_MATURE = 5;
const MIN_SIGNALS_DEAD = 10;
const LOW_AGENT_FIRE = 0.10;
const DEFAULT_MAX_CANDIDATES = 5;
const DEFAULT_MAX_APPLY = 3;
const DEFAULT_COOLDOWN_DAYS = 7;

interface PriorAction {
  source_id: string;
  taken_at: string;
}

export async function curateWorkspaceSources(
  sb: SupabaseClient,
  workspace_id: string,
  opts: CurateOpts = {},
): Promise<{ decisions: CuratorDecision[]; applied: number; skipped_cooldown: string[] }> {
  const apply = opts.apply ?? false;
  const maxCandidates = opts.max_candidates ?? DEFAULT_MAX_CANDIDATES;
  const maxApply = opts.max_apply ?? DEFAULT_MAX_APPLY;
  const cooldownDays = opts.cooldown_days ?? DEFAULT_COOLDOWN_DAYS;

  const [metrics7d, metrics14d, workspaceRow, recentActions] = await Promise.all([
    getSourceMetrics(sb, workspace_id, 24 * 7),
    getSourceMetrics(sb, workspace_id, 24 * 14),
    sb.from('workspaces').select('constitution, about, icp, policy').eq('id', workspace_id).single(),
    sb.from('events')
      .select('payload, created_at')
      .eq('workspace_id', workspace_id)
      .eq('actor_id', ACTOR_ID)
      .eq('action', 'agent_action_taken')
      .gte('created_at', new Date(Date.now() - cooldownDays * 86400 * 1000).toISOString()),
  ]);
  if (workspaceRow.error || !workspaceRow.data) throw new Error(`workspace load failed: ${workspaceRow.error?.message ?? 'not found'}`);

  const metrics14dBySource = new Map<string, SourceMetric>();
  for (const m of metrics14d) metrics14dBySource.set(m.source_id, m);
  const priorMutated = new Set<string>();
  for (const e of (recentActions.data ?? []) as Array<{ payload: { source_id?: string } | null; created_at: string }>) {
    if (e.payload?.source_id) priorMutated.add(e.payload.source_id);
  }
  const skipped_cooldown: string[] = [];

  // Pre-filter heuristic: collect candidates worth showing the LLM.
  const candidates: SourceMetric[] = [];
  for (const m of metrics7d) {
    if (!m.active) continue;
    const m14 = metrics14dBySource.get(m.source_id);
    const signals14 = m14?.signals ?? 0;
    if (priorMutated.has(m.source_id)) { skipped_cooldown.push(m.name); continue; }
    const matureDead = m.signals >= MIN_SIGNALS_MATURE && m.fact_yield === 0 && signals14 >= MIN_SIGNALS_MATURE * 2;
    const lowFire   = m.signals >= MIN_SIGNALS_DEAD && m.agent_fire_rate < LOW_AGENT_FIRE && m.fact_yield === 0;
    const noOutput  = signals14 === 0;
    if (matureDead || lowFire || noOutput) candidates.push(m);
  }
  // Stable sort: most signal volume first → highest leverage to fix.
  candidates.sort((a, b) => b.signals - a.signals);
  const slice = candidates.slice(0, maxCandidates);

  if (slice.length === 0) return { decisions: [], applied: 0, skipped_cooldown };

  // For each candidate, load 5 sample signals + the source row, then call the LLM.
  //
  // Five rows per candidate, asked for five rows at a time. This used to read
  // the workspace's whole signal table and sift 25 rows out of it in memory,
  // and `.limit(20000)` did not even do that: PostgREST caps a response at 1000
  // rows, so it was the newest 1000 signals, and a source that had gone quiet
  // for longer than those 1000 span handed the model no samples at all. It read
  // every body_for_embedding in the workspace once a day to do it.
  //
  // Bounded by SAMPLE_WINDOW_DAYS so a dead source answers fast instead of
  // scanning the table to prove it has nothing. A dead source having no samples
  // is correct: what to do about it is decided by its metrics, and the samples
  // are here to rewrite the query of a source that is still producing.
  const candidateIds = slice.map((c) => c.source_id);
  const sampleSince = new Date(Date.now() - SAMPLE_WINDOW_DAYS * 86400 * 1000).toISOString();
  const [sourceRowsRes, ...sampleRes] = await Promise.all([
    sb.from('sources').select('id, name, connector_type, config, schedule_cron').in('id', candidateIds),
    ...candidateIds.map((sid) => sb.from('signals').select('body_for_embedding, created_at, entity_id')
      .eq('workspace_id', workspace_id)
      .eq('structured_tags->>source_id', sid)
      .gte('created_at', sampleSince)
      .order('created_at', { ascending: false })
      .limit(SAMPLE_SIGNALS)),
  ]);
  const sourceRowById = new Map((sourceRowsRes.data ?? []).map((s: any) => [s.id, s]));
  const samplesBySource = new Map<string, Array<{ body: string; created_at: string; entity_id: string | null }>>();
  candidateIds.forEach((sid, i) => {
    const rows = (sampleRes[i]?.data ?? []) as Array<{ body_for_embedding: string | null; created_at: string; entity_id: string | null }>;
    samplesBySource.set(sid, rows.map((s) => ({
      body: (s.body_for_embedding ?? '').slice(0, 400), created_at: s.created_at, entity_id: s.entity_id,
    })));
  });

  const decisions: CuratorDecision[] = [];
  for (const m of slice) {
    const sourceRow: any = sourceRowById.get(m.source_id);
    if (!sourceRow) continue;
    const m14 = metrics14dBySource.get(m.source_id);
    const samples = samplesBySource.get(m.source_id) ?? [];
    let decision: CuratorDecision;
    try {
      decision = await decideOneSource(sb, workspace_id, workspaceRow.data, sourceRow, m, m14, samples);
    } catch (e) {
      decision = {
        source_id: m.source_id,
        source_name: m.name,
        action: 'no_action',
        reasoning: `LLM decision failed: ${(e as Error).message}`,
        metrics_snapshot: { signals_7d: m.signals, signals_14d: m14?.signals ?? 0, agent_fire_rate_7d: m.agent_fire_rate, fact_yield_7d: m.fact_yield },
      };
    }
    decisions.push(decision);
  }

  let applied = 0;
  if (apply) {
    for (const d of decisions) {
      if (applied >= maxApply) break;
      if (d.action === 'no_action') continue;
      const ok = await applyCuratorDecision(sb, workspace_id, d, sourceRowById.get(d.source_id));
      if (ok) applied += 1;
    }
  }

  return { decisions, applied, skipped_cooldown };
}

interface WorkspaceCtx { constitution: string | null; about: string | null; icp: Record<string, unknown> | null; policy: Record<string, unknown> | null }

async function decideOneSource(
  sb: SupabaseClient,
  workspace_id: string,
  ws: WorkspaceCtx,
  source: { name: string; connector_type: string; config: Record<string, unknown>; schedule_cron: string | null },
  metrics7d: SourceMetric,
  metrics14d: SourceMetric | undefined,
  samples: Array<{ body: string; created_at: string; entity_id: string | null }>,
): Promise<CuratorDecision> {
  const systemPrompt = `You are a source curator for an agent-native CRM. Your job: look at how one signal source is performing and decide whether to deactivate it, rewrite its query, add a wider subscription that can catch its signals, or leave it alone.

Decision rules:
  - "deactivate": source produces signals but they're not relevant to this workspace's ICP / about / constitution. Or: source produced 0 signals over 14 days despite running OK (the query returns nothing).
  - "rewrite_query": source's signals ARE relevant, but the current query is missing the obvious hooks. Suggest a tighter or more targeted query. ONLY for exa or web connectors (config has a 'query' field).
  - "add_catchall_subscription": source's signals look relevant AND are firing, but no subscription's semantic_query catches them (low agent_fire_rate, fact_yield 0). Suggest a new wider subscription embedding text.
  - "no_action": pick this when the picture is unclear or any action would be guessing.

Output ONLY a JSON object matching:
{"action":"deactivate"|"rewrite_query"|"add_catchall_subscription"|"no_action","reasoning":"<one short sentence>","new_query":"<required if rewrite_query>","new_subscription_semantic":"<required if add_catchall_subscription>"}`;

  const userPrompt = `WORKSPACE
about: ${ws.about ?? '(none)'}
icp: ${JSON.stringify(ws.icp ?? {})}
constitution (first 800 chars): ${(ws.constitution ?? '').slice(0, 800)}

SOURCE
name: ${source.name}
connector_type: ${source.connector_type}
config: ${JSON.stringify(source.config).slice(0, 600)}
schedule_cron: ${source.schedule_cron ?? '(none)'}

METRICS (7d)
signals: ${metrics7d.signals}
unmatched_rate: ${metrics7d.unmatched_rate.toFixed(2)}
agent_fire_rate: ${metrics7d.agent_fire_rate.toFixed(2)}
fact_yield (avg facts per enriched signal): ${metrics7d.fact_yield.toFixed(2)}
entities_seeded: ${metrics7d.entities_seeded}

METRICS (14d)
signals: ${metrics14d?.signals ?? 0}

RECENT SAMPLE SIGNALS (up to 5)
${samples.length ? samples.map((s, i) => `[${i + 1}] (${s.created_at.slice(0, 10)}) ${s.body.slice(0, 300)}`).join('\n') : '(no samples available in window)'}

Decide. Return JSON only.`;

  const llm = await chatCompleteForWorkspace(sb, workspace_id, {
    model: CURATOR_MODEL,
    behavior: 'curator',
    // Keep / tune / kill on a whole data source, argued from its metrics. This
    // one is worth thinking about, so the thinking stays on and the ceiling
    // moves up to hold it: at 300 the call could not finish and the answer only
    // ever arrived on the retry, so every decision was billed twice. Raising a
    // ceiling cannot make a call that already fits cost more.
    max_tokens: 4000,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  });

  const parsed = JSON.parse(llm.text) as {
    action: CuratorAction;
    reasoning?: string;
    new_query?: string;
    new_subscription_semantic?: string;
  };
  const action: CuratorAction =
    parsed.action === 'deactivate' || parsed.action === 'rewrite_query' ||
    parsed.action === 'add_catchall_subscription' || parsed.action === 'no_action'
      ? parsed.action : 'no_action';

  // Validate action-required fields; downgrade to no_action if missing.
  let finalAction = action;
  if (action === 'rewrite_query' && (!parsed.new_query || parsed.new_query.length < 5)) finalAction = 'no_action';
  if (action === 'add_catchall_subscription' && (!parsed.new_subscription_semantic || parsed.new_subscription_semantic.length < 10)) finalAction = 'no_action';
  if (action === 'rewrite_query' && !(source.connector_type === 'exa' || source.connector_type === 'web')) finalAction = 'no_action';

  return {
    source_id: metrics7d.source_id,
    source_name: metrics7d.name,
    action: finalAction,
    reasoning: (parsed.reasoning ?? '').slice(0, 300),
    new_query: finalAction === 'rewrite_query' ? parsed.new_query : undefined,
    new_subscription_semantic: finalAction === 'add_catchall_subscription' ? parsed.new_subscription_semantic : undefined,
    metrics_snapshot: {
      signals_7d: metrics7d.signals,
      signals_14d: metrics14d?.signals ?? 0,
      agent_fire_rate_7d: metrics7d.agent_fire_rate,
      fact_yield_7d: metrics7d.fact_yield,
    },
  };
}

async function applyCuratorDecision(
  sb: SupabaseClient,
  workspace_id: string,
  d: CuratorDecision,
  sourceRow: { id: string; config: Record<string, unknown>; active?: boolean } | undefined,
): Promise<boolean> {
  if (!sourceRow) return false;
  const actor = { workspace_id, actor_kind: 'system' as const, actor_id: ACTOR_ID };

  if (d.action === 'deactivate') {
    const r = await callTool(sb, actor, 'update_source', {
      source_id: d.source_id,
      active: false,
      prior_state: { active: true },
      reasoning: d.reasoning,
    });
    if (!r.ok) return false;
    await writeAgentActionEvent(sb, workspace_id, 'deactivate', d, { event_id: r.event_id });
    return true;
  }

  if (d.action === 'rewrite_query') {
    const priorConfig = { ...sourceRow.config };
    const newConfig = { ...priorConfig, query: d.new_query };
    const r = await callTool(sb, actor, 'update_source', {
      source_id: d.source_id,
      config: newConfig,
      prior_state: { config: priorConfig },
      reasoning: d.reasoning,
    });
    if (!r.ok) return false;
    await writeAgentActionEvent(sb, workspace_id, 'rewrite_query', d, { event_id: r.event_id });
    return true;
  }

  if (d.action === 'add_catchall_subscription') {
    const r = await callTool(sb, actor, 'create_subscription', {
      owner_kind: 'agent',
      owner_id: `claims_curator_catchall_${d.source_id.slice(0, 8)}`,
      name: `curator_catchall_${d.source_name}`,
      semantic_query: d.new_subscription_semantic!,
      structured_filter: {},
      threshold: 0.20,
      action_on_match: 'agent.run',
    });
    if (!r.ok) return false;
    // Flip the new subscription to enricher behavior so it actually does something.
    await sb.from('subscriptions').update({ agent_behavior: 'enricher' }).eq('id', r.target_id);
    await writeAgentActionEvent(sb, workspace_id, 'add_catchall_subscription', d, {
      event_id: r.event_id,
      created_subscription_id: r.target_id,
    });
    return true;
  }

  return false;
}

async function writeAgentActionEvent(
  sb: SupabaseClient,
  workspace_id: string,
  action_type: CuratorAction,
  d: CuratorDecision,
  extras: { event_id?: string; created_subscription_id?: string },
): Promise<void> {
  // Audit row keyed by the curator so the recent_agent_actions tool can find it
  // in one query. Distinct from the underlying update_source event because
  // we want the undo endpoint to look at one consistent action shape.
  await sb.from('events').insert({
    workspace_id,
    actor_kind: 'system',
    actor_id: ACTOR_ID,
    action: 'agent_action_taken',
    target_kind: 'source',
    target_id: d.source_id,
    payload: {
      action_type,
      source_id: d.source_id,
      source_name: d.source_name,
      reasoning: d.reasoning,
      new_query: d.new_query ?? null,
      new_subscription_semantic: d.new_subscription_semantic ?? null,
      underlying_event_id: extras.event_id ?? null,
      created_subscription_id: extras.created_subscription_id ?? null,
      metrics_snapshot: d.metrics_snapshot,
    },
  });
}
