import { createServerClient } from '@agent-crm/db';
import { gate } from '@agent-crm/primitives';
import { healthCheck, scoreAndAssert, sweepWorkspace, callTool } from '@agent-crm/tools';
import { inngest } from '../client.js';

// IDs from sweepWorkspace that warrant gating when RED. Tier 2 checks
// (cron_stale, agent_silence, enricher_silence) overlap with healthCheck;
// excluded here to avoid double-alerts.
const SWEEP_GATE_ON_RED = [
  'signal_diversity:',
  'source_concentration',
  'novelty:24h_vs_prior',
  'cost_per_unique_signal',
  'cost_per_claim',
  'score_distribution',
  'score_signal_coupling',
];

const RECOVERY_LOOKBACK_MIN = 30;
const RECOVERY_LIMIT_PER_RUN = 25;

/**
 * recover-unmatched-signals: every 15 min, find signals older than 30 min that
 * have no `subscription.matched` downstream event and re-emit `signal.created`
 * for each. Idempotent at the matchSignal layer; if a match already exists, the
 * matcher just adds another (which is fine because the dedup happens at the
 * agent_run / event-projection level).
 *
 * Caps work per run to avoid floods. If volume exceeds the cap, surfaces in
 * health_check on the next system-health-monitor tick.
 */
export const recoverUnmatchedSignals = inngest.createFunction(
  { id: 'recover-unmatched-signals' },
  { cron: '*/15 * * * *' },
  async ({ step }) => {
    const candidates = await step.run('scan-workspaces', async () => {
      const supabase = createServerClient();
      const { data: workspaces } = await supabase.from('workspaces').select('id');
      const wsIds = (workspaces ?? []).map((w: { id: string }) => w.id);
      const cutoff = new Date(Date.now() - RECOVERY_LOOKBACK_MIN * 60 * 1000).toISOString();
      const out: Array<{ signal_id: string; workspace_id: string; entity_id: string; type: string; observed_at: string }> = [];

      for (const ws of wsIds) {
        const sigs = await supabase.from('signals').select('id, entity_id, type, observed_at')
          .eq('workspace_id', ws).lt('created_at', cutoff)
          .order('created_at', { ascending: false }).limit(200);
        const sigRows = (sigs.data ?? []) as Array<{ id: string; entity_id: string; type: string; observed_at: string }>;
        if (!sigRows.length) continue;

        const matched = await supabase.from('events').select('payload')
          .eq('workspace_id', ws).eq('action', 'subscription.matched');
        const matchedSet = new Set<string>();
        for (const e of (matched.data ?? []) as Array<{ payload: { signal_id?: string } | null }>) {
          if (e.payload?.signal_id) matchedSet.add(e.payload.signal_id);
        }
        const unmatched = sigRows.filter((s) => !matchedSet.has(s.id)).slice(0, RECOVERY_LIMIT_PER_RUN);
        for (const s of unmatched) out.push({ signal_id: s.id, workspace_id: ws, entity_id: s.entity_id, type: s.type, observed_at: s.observed_at });
        if (out.length >= RECOVERY_LIMIT_PER_RUN) break;
      }
      return out;
    });

    if (!candidates.length) return { recovered: 0 };

    await step.sendEvent('re-emit-signal-created', candidates.map((c) => ({
      name: 'signal.created' as const,
      data: { signal_id: c.signal_id, workspace_id: c.workspace_id, entity_id: c.entity_id, type: c.type, observed_at: c.observed_at },
    })));

    return { recovered: candidates.length };
  },
);

const HEALTH_THRESHOLDS = {
  unmatched_signals: 10,
  errored_sources: 1,
  stale_gates: 1,
  stale_drafts: 5,
};

/**
 * system-health-monitor: every hour, calls healthCheck for each workspace. If any
 * threshold is exceeded, opens a gate so a human gets pinged. Single source of
 * health metrics so the agent and the dashboard see the same numbers.
 */
export const systemHealthMonitor = inngest.createFunction(
  { id: 'system-health-monitor' },
  { cron: '15 * * * *' },
  async ({ step }) => {
    const results = await step.run('check-each-workspace', async () => {
      const supabase = createServerClient();
      const { data: workspaces } = await supabase.from('workspaces').select('id, name');
      const wsRows = (workspaces ?? []) as Array<{ id: string; name: string }>;
      const flagged: Array<{ workspace_id: string; reason: string; metrics: Record<string, number> }> = [];
      for (const ws of wsRows) {
        const h = await healthCheck(supabase, ws.id);
        const breaches: string[] = [];
        if (h.unmatched_signals >= HEALTH_THRESHOLDS.unmatched_signals) breaches.push(`unmatched_signals=${h.unmatched_signals}`);
        if (h.errored_sources >= HEALTH_THRESHOLDS.errored_sources) breaches.push(`errored_sources=${h.errored_sources}`);
        if (h.stale_gates >= HEALTH_THRESHOLDS.stale_gates) breaches.push(`stale_gates=${h.stale_gates}`);
        if (h.stale_drafts >= HEALTH_THRESHOLDS.stale_drafts) breaches.push(`stale_drafts=${h.stale_drafts}`);

        // Sweep adds tier 1/3/4 signal-quality + efficiency + scoring checks.
        // Only RED breaches that aren't already covered by healthCheck escalate.
        const sweep = await sweepWorkspace(supabase, ws.id);
        const sweepBreaches: Record<string, string> = {};
        for (const r of sweep) {
          if (r.severity !== 'red') continue;
          if (!SWEEP_GATE_ON_RED.some((p) => r.id === p || r.id.startsWith(p))) continue;
          breaches.push(`${r.id}=${r.metric}`);
          sweepBreaches[r.id] = r.metric;
        }

        if (breaches.length) {
          flagged.push({
            workspace_id: ws.id,
            reason: breaches.join(', '),
            metrics: {
              unmatched_signals: h.unmatched_signals,
              errored_sources: h.errored_sources,
              stale_gates: h.stale_gates,
              stale_drafts: h.stale_drafts,
              ...sweepBreaches,
            },
          });
        }
      }
      return flagged;
    });

    if (!results.length) return { workspaces_checked: 0, gated: 0 };

    await step.run('open-gates', async () => {
      const supabase = createServerClient();
      for (const r of results) {
        // Suppress duplicate gates: if a system_health gate was opened in the
        // last 12h for this workspace, skip. (Avoids gate spam on persistent issues.)
        const since = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
        const recent = await supabase.from('events').select('id')
          .eq('workspace_id', r.workspace_id).eq('action', 'request_gate').gte('ts', since).limit(50);
        const hasRecentSystemGate = ((recent.data ?? []) as Array<{ id: number }>).length > 0;
        // crude: any recent gate suppresses; refine if needed by inspecting payload.policy
        if (hasRecentSystemGate) continue;
        await gate(supabase, { workspace_id: r.workspace_id, actor_kind: 'system', actor_id: 'system_health_monitor' }, {
          policy: 'system_health',
          condition: r.metrics,
        });
      }
    });

    return { workspaces_checked: results.length, gated: results.length };
  },
);

const RESCORE_LIMIT_PER_RUN = 50;

/**
 * rescore-on-icp-change: every 30 min, find entities whose icp_fit fact is older
 * than the workspace's last icp/about/constitution update, and re-run scoreAndAssert.
 * Caps at 50 entities/run to bound LLM cost. Uses supersede chain so unchanged scores
 * are no-ops.
 *
 * Why: when you tune ICP/about, every entity's score should refresh. Without this,
 * scores only update on the next enricher run for that entity (could be never).
 */
export const rescoreOnIcpChange = inngest.createFunction(
  { id: 'rescore-on-icp-change' },
  { cron: '*/30 * * * *' },
  async ({ step }) => {
    const candidates = await step.run('scan-stale-scores', async () => {
      const supabase = createServerClient();
      const { data: workspaces } = await supabase.from('workspaces').select('id, updated_at');
      const wsRows = (workspaces ?? []) as Array<{ id: string; updated_at: string }>;
      const out: Array<{ workspace_id: string; entity_id: string }> = [];

      for (const ws of wsRows) {
        // Case A: entities whose most-recent icp_fit fact is older than the
        // workspace update. (User re-tuned ICP — refresh all scores.)
        const stale = await supabase.from('facts')
          .select('subject_entity, observed_at')
          .eq('workspace_id', ws.id).eq('predicate', 'icp_fit')
          .is('supersedes', null)
          .lt('observed_at', ws.updated_at)
          .order('observed_at', { ascending: true })
          .limit(RESCORE_LIMIT_PER_RUN);
        for (const r of (stale.data ?? []) as Array<{ subject_entity: string }>) {
          out.push({ workspace_id: ws.id, entity_id: r.subject_entity });
        }
        if (out.length >= RESCORE_LIMIT_PER_RUN) break;

        // Case B: accounts that have NEVER been scored. Pre-existing accounts
        // from before scoring shipped, or accounts whose enricher run failed
        // to call scoreAndAssert for some reason. Without this branch, an
        // account can sit unscored forever and the drafter treats it as low
        // fit by default.
        const scoredRes = await supabase.from('facts')
          .select('subject_entity')
          .eq('workspace_id', ws.id).eq('predicate', 'icp_fit')
          .is('supersedes', null)
          .limit(10000);
        const scoredSet = new Set<string>(((scoredRes.data ?? []) as Array<{ subject_entity: string }>).map((f) => f.subject_entity));

        const allAccts = await supabase.from('entities')
          .select('id, created_at')
          .eq('workspace_id', ws.id).eq('kind', 'account')
          .order('created_at', { ascending: true })
          .limit(10000);
        const unscored = ((allAccts.data ?? []) as Array<{ id: string; created_at: string }>)
          .filter((a) => !scoredSet.has(a.id))
          .slice(0, RESCORE_LIMIT_PER_RUN - out.length);
        for (const a of unscored) out.push({ workspace_id: ws.id, entity_id: a.id });
        if (out.length >= RESCORE_LIMIT_PER_RUN) break;
      }
      return out;
    });

    if (!candidates.length) return { rescored: 0 };

    await step.run('rescore-batch', async () => {
      const supabase = createServerClient();
      const actor = (workspace_id: string) => ({ workspace_id, actor_kind: 'system' as const, actor_id: 'icp_rescorer' });
      let rescored = 0;
      for (const c of candidates) {
        try {
          await scoreAndAssert(supabase, actor(c.workspace_id), c.entity_id);
          rescored++;
        } catch {
          // skip; next cron tick retries
        }
      }
      return rescored;
    });

    return { rescored: candidates.length };
  },
);

const SILENCE_DAYS = 7;
const SILENCE_LIMIT_PER_RUN = 100;

/**
 * silence-sweep: daily check for entities we emailed N+ days ago that haven't
 * replied. Posts a `no_reply` outcome to the entity's channel and triggers a
 * fresh score so action_selector reconsiders. Idempotent via `no_reply_marked`
 * fact — only the first time we hit silence for a given send.
 *
 * Reply ingest (Resend webhook → inbound_email fact) is not wired yet; until
 * then this cron is the only signal that a send went unanswered.
 */
export const silenceSweep = inngest.createFunction(
  { id: 'silence-sweep' },
  { cron: '0 12 * * *' }, // daily at noon UTC
  async ({ step }) => {
    const candidates = await step.run('scan-silent-entities', async () => {
      const supabase = createServerClient();
      const { data: workspaces } = await supabase.from('workspaces').select('id');
      const wsRows = (workspaces ?? []) as Array<{ id: string }>;
      const cutoff = new Date(Date.now() - SILENCE_DAYS * 86400_000).toISOString();
      const out: Array<{ workspace_id: string; entity_id: string; last_outreach_at: string }> = [];
      for (const ws of wsRows) {
        // Entities with last_outreach_at older than the cutoff. Active facts only.
        const sent = await supabase.from('facts')
          .select('subject_entity, object_text')
          .eq('workspace_id', ws.id).eq('predicate', 'last_outreach_at')
          .is('supersedes', null)
          .lt('object_text', cutoff)
          .limit(1000);
        const sentRows = (sent.data ?? []) as Array<{ subject_entity: string; object_text: string }>;
        if (!sentRows.length) continue;

        // Pull all replied_at and no_reply_marked facts in one round-trip;
        // filter in memory to avoid N queries.
        const ids = sentRows.map((r) => r.subject_entity);
        const followups = await supabase.from('facts')
          .select('subject_entity, predicate')
          .eq('workspace_id', ws.id)
          .in('subject_entity', ids)
          .in('predicate', ['replied_at', 'no_reply_marked'])
          .is('supersedes', null);
        const skip = new Set<string>(((followups.data ?? []) as Array<{ subject_entity: string }>).map((r) => r.subject_entity));

        for (const r of sentRows) {
          if (skip.has(r.subject_entity)) continue;
          out.push({ workspace_id: ws.id, entity_id: r.subject_entity, last_outreach_at: r.object_text });
          if (out.length >= SILENCE_LIMIT_PER_RUN) break;
        }
        if (out.length >= SILENCE_LIMIT_PER_RUN) break;
      }
      return out;
    });

    if (!candidates.length) return { silent: 0 };

    await step.run('mark-and-rescore', async () => {
      const supabase = createServerClient();
      for (const c of candidates) {
        const actor = { workspace_id: c.workspace_id, actor_kind: 'system' as const, actor_id: 'silence_sweep' };
        try {
          // Idempotent marker so we don't re-process this send next cron tick.
          // Drives the action_selector via score_signal_strength=0 on next score run.
          await callTool(supabase, actor, 'assert_fact', {
            subject_entity: c.entity_id,
            predicate: 'no_reply_marked',
            object_text: new Date().toISOString(),
            confidence: 1.0,
          });
          // Best-effort score recompute. Failures here are non-fatal —
          // next rescore-on-icp-change tick catches anything we miss.
          try { await scoreAndAssert(supabase, actor, c.entity_id); } catch { /* skip */ }
        } catch { /* per-entity failure shouldn't stop the batch */ }
      }
    });

    return { silent: candidates.length };
  },
);
