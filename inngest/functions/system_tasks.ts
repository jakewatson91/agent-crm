import { createServerClient } from '@agent-crm/db';
import {
  scoreAndAssert, callTool, entityIdsOfType, runRetention,
  ensureScoringConfigState, fetchAll, latestMarkerByEntity,
  recordActivityMarker, ACTIVITY_MARKERS,
} from '@agent-crm/tools';
import { inngest } from '../client.js';

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

        // Scope the marker lookup to the candidate signals only. The marker's
        // target_id IS the signal_id (match_signal.ts), so .in() returns exactly
        // the markers we care about. The old unbounded select hit PostgREST's
        // 1000-row default cap once a workspace had >1000 markers, hiding the
        // rest, so already-matched signals looked unmatched and got re-emitted
        // every 15 min — a self-feeding loop (each re-emit wrote another marker,
        // growing the table, hiding even more). That alone was ~3× re-processing
        // and the bulk of our Inngest run spend.
        const sigIds = sigRows.map((s) => s.id);
        const matched = await supabase.from('events').select('target_id')
          .eq('workspace_id', ws).eq('action', 'subscription.matched')
          .in('target_id', sigIds);
        const matchedSet = new Set<string>(
          ((matched.data ?? []) as Array<{ target_id: string | null }>)
            .map((e) => e.target_id)
            .filter((id): id is string => Boolean(id)),
        );
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

// system-health-monitor was removed: it opened a system_health approval on every
// hourly tick (and its de-dup guard queried a non-existent column, so it never
// suppressed — 91 phantom approvals piled up). Per decide-and-notify, system
// health is not approval-worthy; approvals are only for irreversible external
// actions. Health now lives only in the on-demand sweep (sweepWorkspace) and the
// read-only feed health strip — neither interrupts a human.

const RESCORE_LIMIT_PER_RUN = 50;

/**
 * rescore-on-icp-change: every 30 min, find entities whose current icp_fit fact
 * predates the workspace's last scoring-config change, and re-run scoreAndAssert.
 * Caps at 50 entities/run to bound LLM cost.
 *
 * Why: when you tune ICP/about, every entity's score should refresh. Without this,
 * scores only update on the next enricher run for that entity (could be never).
 *
 * Two failure modes this scan must avoid (both shipped, both found 2026-07-12):
 * 1. `.is('supersedes', null)` on icp_fit returns the ORIGINAL fact in a
 *    supersede chain — its observed_at never moves, so every account ever
 *    scored looked stale forever. Read the CURRENT fact (the one no other row
 *    points at) instead.
 * 2. Comparing against workspaces.updated_at — which bumps on EVERY policy
 *    write, including the advance pass's daily pipeline-status write — made
 *    the whole book "stale" daily. Compare against scoring_config_state
 *    .changed_at, which only moves on real icp/about/persona/scoring edits.
 * On top of that, entities where scoreAndAssert legitimately returns null
 * (candidate-flagged, dropped, nothing changed) write no fact, so they'd be
 * re-picked every tick and starve everyone else — those get a rescore_noop
 * marker and are skipped until the config changes again.
 */
export const rescoreOnIcpChange = inngest.createFunction(
  { id: 'rescore-on-icp-change' },
  { cron: '*/30 * * * *' },
  async ({ step }) => {
    const candidates = await step.run('scan-stale-scores', async () => {
      const supabase = createServerClient();
      const { data: workspaces } = await supabase.from('workspaces').select('id');
      const wsRows = (workspaces ?? []) as Array<{ id: string }>;
      const out: Array<{ workspace_id: string; entity_id: string }> = [];

      for (const ws of wsRows) {
        const cfgChangedAt = await ensureScoringConfigState(supabase, ws.id);

        // Case A: entities whose CURRENT icp_fit fact predates the last
        // scoring-config change. (User re-tuned ICP — refresh all scores.)
        const rows = await fetchAll<{ id: string; subject_entity: string; observed_at: string; supersedes: string | null }>(
          (from, to) => supabase.from('facts')
            .select('id, subject_entity, observed_at, supersedes')
            .eq('workspace_id', ws.id).eq('predicate', 'icp_fit')
            .order('id', { ascending: true })
            .range(from, to),
        );
        const cfgMs = Date.parse(cfgChangedAt);
        const pointedTo = new Set(rows.map((r) => r.supersedes).filter((x): x is string => !!x));
        const stale = rows
          .filter((r) => !pointedTo.has(r.id) && Date.parse(r.observed_at) < cfgMs)
          .sort((a, b) => a.observed_at.localeCompare(b.observed_at));

        // Case B: accounts that have NEVER been scored. Pre-existing accounts
        // from before scoring shipped, or accounts whose enricher run failed
        // to call scoreAndAssert for some reason. Without this branch, an
        // account can sit unscored forever and the drafter treats it as low
        // fit by default. (Ever-scored = any icp_fit row, original included.)
        const scoredSet = new Set(rows.map((r) => r.subject_entity));
        const acctIds = (await entityIdsOfType(supabase, ws.id, 'account')).slice(0, 10000);
        const allAccts = acctIds.length === 0
          ? { data: [] as Array<{ id: string; created_at: string }> }
          : await supabase.from('entities')
              .select('id, created_at')
              .in('id', acctIds)
              .order('created_at', { ascending: true });
        const unscored = ((allAccts.data ?? []) as Array<{ id: string; created_at: string }>)
          .filter((a) => !scoredSet.has(a.id));

        // Skip entities we already attempted since the last config change and
        // that returned null — retrying them is a guaranteed no-op until the
        // config moves again.
        const pool = [...stale.map((r) => r.subject_entity), ...unscored.map((a) => a.id)].slice(0, 2000);
        if (!pool.length) continue;
        const attempted = await latestMarkerByEntity(
          supabase, ws.id, pool, [ACTIVITY_MARKERS.RESCORE_NOOP],
        );
        for (const id of pool) {
          if (out.length >= RESCORE_LIMIT_PER_RUN) break;
          const marker = attempted.get(id);
          if (marker !== undefined && marker > cfgMs) continue;
          out.push({ workspace_id: ws.id, entity_id: id });
        }
        if (out.length >= RESCORE_LIMIT_PER_RUN) break;
      }
      return out;
    });

    if (!candidates.length) return { candidates: 0, rescored: 0, noop: 0 };

    const result = await step.run('rescore-batch', async () => {
      const supabase = createServerClient();
      const actor = (workspace_id: string) => ({ workspace_id, actor_kind: 'system' as const, actor_id: 'icp_rescorer' });
      let rescored = 0;
      let noop = 0;
      for (const c of candidates) {
        try {
          const score = await scoreAndAssert(supabase, actor(c.workspace_id), c.entity_id);
          if (score === null) {
            // Deterministic refusal — mark it so the scan stops re-picking this
            // entity every tick. A thrown error (transient LLM/provider issue)
            // deliberately writes NO marker, so the next tick retries.
            await recordActivityMarker(supabase, actor(c.workspace_id), ACTIVITY_MARKERS.RESCORE_NOOP, c.entity_id);
            noop++;
          } else {
            rescored++;
          }
        } catch {
          // skip; next cron tick retries
        }
      }
      return { rescored, noop };
    });

    return { candidates: candidates.length, ...result };
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

// Days an entity must sit with zero downstream activity before sweep archives it.
// Long enough that a slow-burn signal can still arrive; short enough that
// connector-noise entities don't accumulate forever.
const ENTITY_SWEEP_AGE_DAYS = 14;
const ENTITY_SWEEP_LIMIT_PER_RUN = 500;

/**
 * entity-archive-sweep: daily, archive entities that connectors created but
 * which never accumulated any downstream signal — no signals, no facts, no
 * channel_posts. After ENTITY_SWEEP_AGE_DAYS the row is junk. Soft-delete
 * via archived_at so audit/replay still reaches the history.
 *
 * Decide-and-notify: archiving is reversible (flip archived_at back to null)
 * so the sweep runs autonomously, no gate.
 */
export const entityArchiveSweep = inngest.createFunction(
  { id: 'entity-archive-sweep' },
  { cron: '30 12 * * *' }, // daily at 12:30 UTC, after silence-sweep
  async ({ step }) => {
    const toArchive = await step.run('scan-low-signal-entities', async () => {
      const supabase = createServerClient();
      const cutoff = new Date(Date.now() - ENTITY_SWEEP_AGE_DAYS * 86400_000).toISOString();

      const { data: ents } = await supabase
        .from('entities')
        .select('id, workspace_id, name, attributes, created_at')
        .lt('created_at', cutoff)
        .is('archived_at', null)
        .limit(ENTITY_SWEEP_LIMIT_PER_RUN * 4);
      const candidates = (ents ?? []) as Array<{
        id: string; workspace_id: string; name: string;
        attributes: Record<string, unknown>; created_at: string;
      }>;
      if (!candidates.length) return [];

      const ids = candidates.map((e) => e.id);

      // Three "has activity" queries; any hit disqualifies the entity from sweep.
      const [factHits, signalHits, postHits] = await Promise.all([
        supabase.from('facts').select('subject_entity').in('subject_entity', ids).limit(ids.length),
        supabase.from('signals').select('entity_id').in('entity_id', ids).limit(ids.length),
        supabase.from('channels').select('id, account_entity_id').in('account_entity_id', ids),
      ]);

      const hasActivity = new Set<string>();
      for (const r of (factHits.data ?? []) as Array<{ subject_entity: string }>) hasActivity.add(r.subject_entity);
      for (const r of (signalHits.data ?? []) as Array<{ entity_id: string }>) hasActivity.add(r.entity_id);

      // A connector can mark an entity as a recurring watch target by setting the
      // reserved `_watched_by_source` attribute flag — e.g. the ATS connector
      // sets it on a company whose job board it re-polls every run. Such an
      // entity legitimately sits with zero facts/signals between hits (nothing
      // has passed its filter yet), so the activity checks above don't protect
      // it. Without this guard the sweep buries the exact accounts a recurring
      // connector depends on (it archived 48 of 61 board owners once already).
      // The flag is generic: the sweep names no connector, and any future
      // connector that adopts an entity for ongoing watching sets the same flag.
      for (const e of candidates) {
        if (e.attributes?._watched_by_source) hasActivity.add(e.id);
      }

      const channelIds = ((postHits.data ?? []) as Array<{ id: string; account_entity_id: string }>).map((c) => c.id);
      const channelToEntity = new Map<string, string>(
        ((postHits.data ?? []) as Array<{ id: string; account_entity_id: string }>)
          .map((c) => [c.id, c.account_entity_id]),
      );
      if (channelIds.length) {
        const { data: posts } = await supabase.from('channel_posts').select('channel_id').in('channel_id', channelIds);
        for (const p of (posts ?? []) as Array<{ channel_id: string }>) {
          const eid = channelToEntity.get(p.channel_id);
          if (eid) hasActivity.add(eid);
        }
      }

      return candidates
        .filter((e) => !hasActivity.has(e.id))
        .slice(0, ENTITY_SWEEP_LIMIT_PER_RUN)
        .map((e) => ({ id: e.id, workspace_id: e.workspace_id, name: e.name }));
    });

    if (!toArchive.length) return { archived: 0 };

    await step.run('flip-archived-at', async () => {
      const supabase = createServerClient();
      const now = new Date().toISOString();
      const { error } = await supabase
        .from('entities')
        .update({ archived_at: now })
        .in('id', toArchive.map((e) => e.id));
      if (error) throw error;
    });

    return { archived: toArchive.length, ids: toArchive.map((e) => e.id) };
  },
);

/**
 * retention-sweep: daily, bound the two unbounded tables per workspace —
 * archive old signal embeddings and prune whitelisted telemetry events. All
 * config + safety lives in runRetention (workspaces.policy.retention, off by
 * default). The launchd loop also calls runRetention; the shared ~daily
 * throttle keeps the two from doubling up.
 *
 * Note: the weekly CONCURRENT reindex of the HNSW index that reclaims the disk
 * freed by archived embeddings lives in the launchd loop only — REINDEX
 * CONCURRENTLY can't run in a function or over PostgREST, so it needs the loop's
 * direct connection. This cron does the null + prune; the loop does the reindex.
 */
export const retentionSweep = inngest.createFunction(
  { id: 'retention-sweep' },
  { cron: '0 13 * * *' }, // daily at 13:00 UTC, after the other daily sweeps
  async ({ step }) => {
    return await step.run('run-retention', async () => {
      const supabase = createServerClient();
      const { data: wss } = await supabase.from('workspaces').select('id');
      const results = [];
      for (const w of (wss ?? []) as Array<{ id: string }>) {
        try {
          results.push(await runRetention(supabase, w.id));
        } catch (e) {
          results.push({ workspace_id: w.id, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return { workspaces: results.length, results };
    });
  },
);
