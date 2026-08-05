import { createServerClient } from '@agent-crm/db';
import {
  scoreAndAssert, callTool, entityIdsOfType, runRetention,
  ensureScoringConfigState, fetchAll, latestMarkerByEntity,
  recordActivityMarker, ACTIVITY_MARKERS, isSubstantiveFact,
  getPolicy, resolveEnvVar, resolveDomainViaSearch,
  getPipelineStatus, setPipelineStatus,
  backfillAccountDomainsFromContactEmails, backfillAliases,
} from '@agent-crm/tools';
import { isHaltingError } from './advance_accounts.js';
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
// Case C looks for substantive facts observed inside this window. 72h (vs the
// 30-min tick) tolerates cron outages of up to three days without losing a
// rescore trigger; scanning the whole facts table instead would re-run the
// egress mistake (30-47K rows/workspace × 48 ticks/day).
const RESCORE_FACT_LOOKBACK_MS = 72 * 3600_000;

/**
 * rescore-on-icp-change: every 30 min, find entities whose score is out of date
 * and re-run scoreAndAssert. Caps at 50 entities/run to bound LLM cost.
 * Three pools: (A) current icp_fit predates the last scoring-config change,
 * (B) never scored, (C) a substantive fact landed after the current icp_fit —
 * ATS signals, CSV imports, and research facts arrive without an enricher
 * rescore, so without C a quiet account's ranking never reflects new evidence.
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
export async function scanRescoreCandidates(
  supabase: ReturnType<typeof createServerClient>,
): Promise<Array<{ workspace_id: string; entity_id: string }>> {
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

    // Case C: scored accounts whose evidence outran their score — a
    // substantive fact (isSubstantiveFact: not bookkeeping, not a score
    // output) was observed after the current icp_fit was asserted. Only
    // facts inside the lookback window are scanned; older debt re-enters
    // when the account's next fact lands. Entities without an icp_fit are
    // pool B's job, so C needs no entity-type check: only accounts carry
    // icp_fit facts.
    const factCutoff = new Date(Date.now() - RESCORE_FACT_LOOKBACK_MS).toISOString();
    const recentFacts = await fetchAll<{ subject_entity: string; predicate: string; observed_at: string }>(
      (from, to) => supabase.from('facts')
        .select('subject_entity, predicate, observed_at')
        .eq('workspace_id', ws.id)
        .gte('observed_at', factCutoff)
        .order('id', { ascending: true })
        .range(from, to),
    );
    const latestFactMs = new Map<string, number>();
    for (const r of recentFacts) {
      if (!isSubstantiveFact(r.predicate)) continue;
      const ts = Date.parse(r.observed_at);
      if (Number.isFinite(ts) && ts > (latestFactMs.get(r.subject_entity) ?? 0)) {
        latestFactMs.set(r.subject_entity, ts);
      }
    }
    const currentScoreMs = new Map<string, number>();
    for (const r of rows) {
      if (pointedTo.has(r.id)) continue;
      const ts = Date.parse(r.observed_at);
      if (Number.isFinite(ts) && ts > (currentScoreMs.get(r.subject_entity) ?? 0)) {
        currentScoreMs.set(r.subject_entity, ts);
      }
    }
    const outran: Array<{ id: string; factMs: number }> = [];
    for (const [ent, factMs] of latestFactMs) {
      const scoreMs = currentScoreMs.get(ent);
      if (scoreMs !== undefined && factMs > scoreMs) outran.push({ id: ent, factMs });
    }
    outran.sort((a, b) => a.factMs - b.factMs); // oldest unscored evidence first

    // Skip entities we already attempted (noop) unless something moved
    // since that attempt: a config change (pools A/B) or a newer fact
    // (pool C). One rule covers all pools.
    const pool = [...new Set([
      ...stale.map((r) => r.subject_entity),
      ...unscored.map((a) => a.id),
      ...outran.map((o) => o.id),
    ])].slice(0, 2000);
    if (!pool.length) continue;
    const attempted = await latestMarkerByEntity(
      supabase, ws.id, pool, [ACTIVITY_MARKERS.RESCORE_NOOP],
    );
    for (const id of pool) {
      if (out.length >= RESCORE_LIMIT_PER_RUN) break;
      const marker = attempted.get(id);
      if (marker !== undefined && marker > Math.max(cfgMs, latestFactMs.get(id) ?? 0)) continue;
      out.push({ workspace_id: ws.id, entity_id: id });
    }
    if (out.length >= RESCORE_LIMIT_PER_RUN) break;
  }
  return out;
}

export async function runRescoreBatch(
  supabase: ReturnType<typeof createServerClient>,
  candidates: Array<{ workspace_id: string; entity_id: string }>,
): Promise<{ rescored: number; noop: number }> {
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
}

export const rescoreOnIcpChange = inngest.createFunction(
  { id: 'rescore-on-icp-change' },
  { cron: '*/30 * * * *' },
  async ({ step }) => {
    const candidates = await step.run('scan-stale-scores', async () =>
      scanRescoreCandidates(createServerClient()));
    if (!candidates.length) return { candidates: 0, rescored: 0, noop: 0 };

    const result = await step.run('rescore-batch', async () =>
      runRescoreBatch(createServerClient(), candidates));
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

      // "Has activity" presence checks. A false negative here archives a real, enriched
      // account, so completeness is critical. The old form — one `.in(ids)` over up to a
      // thousand candidate ids with `.limit(ids.length)` — overflowed the request URL AND
      // hit the PostgREST 1000-row cap, so it returned nothing and the sweep archived EVERY
      // candidate (hundreds of live accounts a day). Chunk the id list (URL length) and page
      // each chunk (row cap) so a hit is never missed.
      const CHUNK = 150;
      const hasActivity = new Set<string>();
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        const [factRows, sigRows] = await Promise.all([
          fetchAll<{ subject_entity: string }>((from, to) =>
            supabase.from('facts').select('subject_entity').in('subject_entity', chunk).range(from, to)),
          fetchAll<{ entity_id: string }>((from, to) =>
            supabase.from('signals').select('entity_id').in('entity_id', chunk).range(from, to)),
        ]);
        for (const r of factRows) hasActivity.add(r.subject_entity);
        for (const r of sigRows) hasActivity.add(r.entity_id);
      }

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

      // Channel-post activity — same chunk + page treatment for the channel and post `.in()`s.
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        const chans = await fetchAll<{ id: string; account_entity_id: string }>((from, to) =>
          supabase.from('channels').select('id, account_entity_id').in('account_entity_id', chunk).range(from, to));
        if (!chans.length) continue;
        const channelToEntity = new Map(chans.map((c) => [c.id, c.account_entity_id]));
        const channelIds = chans.map((c) => c.id);
        for (let j = 0; j < channelIds.length; j += CHUNK) {
          const cchunk = channelIds.slice(j, j + CHUNK);
          const posts = await fetchAll<{ channel_id: string }>((from, to) =>
            supabase.from('channel_posts').select('channel_id').in('channel_id', cchunk).range(from, to));
          for (const p of posts) {
            const eid = channelToEntity.get(p.channel_id);
            if (eid) hasActivity.add(eid);
          }
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

// How many step.run batches the daily domain backfill splits its work into.
// One scan step + this many resolve steps ≈ 6 Inngest executions per day,
// regardless of how many entities the per-day knob allows.
const DOMAIN_BACKFILL_BATCHES = 5;
// A name that failed to resolve is retried after this many days. Shorter than
// the research runner's 30-day cooldown: the backfill works the whole book on a
// paced budget, so a weekly re-probe is cheap and catches newly-indexed sites.
const DOMAIN_BACKFILL_REPROBE_DAYS = 7;

export interface DomainBackfillEntry { workspace_id: string; entity_id: string; entity_name: string }

/**
 * Pick today's domain-resolution candidates across all workspaces: account
 * entities with no attributes.domain, not archived, not `_candidate` thin nodes
 * (unscoreable until promoted — a search on one is spend with no downstream),
 * and not inside the failed-resolve cooldown. Capped per workspace by
 * policy.research.domain_backfill_per_day (0/unset = workspace opted out).
 * Skips workspaces whose pipeline is paused for research (credit wall) and
 * workspaces with no Exa key.
 */
export async function scanDomainBackfillCandidates(
  supabase: ReturnType<typeof createServerClient>,
): Promise<DomainBackfillEntry[]> {
  const { data: workspaces } = await supabase.from('workspaces').select('id');
  const out: DomainBackfillEntry[] = [];
  for (const ws of (workspaces ?? []) as Array<{ id: string }>) {
    const policy = await getPolicy(supabase, ws.id);
    const perDay = Math.floor(policy.research?.domain_backfill_per_day ?? 0);
    if (perDay <= 0) continue;
    if (!resolveEnvVar(policy, 'EXA_API_KEY')) continue;
    const pipe = await getPipelineStatus(supabase, ws.id);
    if (pipe?.state === 'paused' && (pipe.scope ?? 'all') !== 'contacts') continue;

    const acctIds = await entityIdsOfType(supabase, ws.id, 'account');
    const missing: Array<{ id: string; name: string }> = [];
    for (let i = 0; i < acctIds.length; i += 200) {
      const { data } = await supabase.from('entities')
        .select('id, name, attributes, archived_at')
        .in('id', acctIds.slice(i, i + 200));
      for (const e of (data ?? []) as Array<{ id: string; name: string; attributes: Record<string, unknown> | null; archived_at: string | null }>) {
        if (e.archived_at) continue;
        if (e.attributes?._candidate === true) continue;
        const domain = e.attributes?.domain;
        if (typeof domain === 'string' && domain.length > 0) continue;
        if (!e.name?.trim()) continue;
        missing.push({ id: e.id, name: e.name });
      }
    }
    if (!missing.length) continue;
    // Best-scoring accounts first, uuid as the tiebreak.
    //
    // This used to sort on uuid alone, which is a stable order but an arbitrary
    // one — the daily budget went to whichever accounts happened to sort early.
    // A domain is the top of the whole chain (research skips any account without
    // one, and research is what lifts signal_strength past the draft gate), and
    // on Sudden 1396 accounts are queued against 75 lookups a day. Spending that
    // budget in uuid order means a 0.9-fit account can wait weeks behind a 0.3.
    // Same spend, same cadence, value-ordered.
    //
    // Accounts with no score yet sort last rather than first: an unscored
    // account is usually one nothing is known about, and the point is to get
    // the best of the book reachable soonest.
    const scoreById = new Map<string, number>();
    for (let i = 0; i < missing.length; i += 200) {
      const slice = missing.slice(i, i + 200).map((m) => m.id);
      const rows = await fetchAll<{ subject_entity: string; object_text: string | null; observed_at: string }>((from, to) =>
        supabase.from('facts').select('subject_entity, object_text, observed_at')
          .eq('workspace_id', ws.id).eq('predicate', 'icp_fit')
          .in('subject_entity', slice).order('id').range(from, to));
      // Current score = latest observed_at. `.is('supersedes', null)` would hand
      // back each entity's first-ever score, which is the bug fixed in 9cf491b.
      const seenAt = new Map<string, string>();
      for (const r of rows) {
        const v = r.object_text ? parseFloat(r.object_text) : NaN;
        if (!Number.isFinite(v)) continue;
        const prev = seenAt.get(r.subject_entity);
        if (prev && r.observed_at <= prev) continue;
        seenAt.set(r.subject_entity, r.observed_at);
        scoreById.set(r.subject_entity, v);
      }
    }
    missing.sort((a, b) => {
      const d = (scoreById.get(b.id) ?? -1) - (scoreById.get(a.id) ?? -1);
      return d !== 0 ? d : a.id.localeCompare(b.id);
    });

    const failedAt = await latestMarkerByEntity(
      supabase, ws.id, missing.map((m) => m.id), [ACTIVITY_MARKERS.DOMAIN_RESOLVE_FAILED],
    );
    const cooldownCutoff = Date.now() - DOMAIN_BACKFILL_REPROBE_DAYS * 86400_000;
    const eligible = missing.filter((m) => (failedAt.get(m.id) ?? 0) < cooldownCutoff);
    for (const m of eligible.slice(0, perDay)) {
      out.push({ workspace_id: ws.id, entity_id: m.id, entity_name: m.name });
    }
  }
  return out;
}

/**
 * Resolve one batch of candidates. Sequential on purpose — this is a background
 * catch-up, not a latency-sensitive path, and pacing keeps Exa happy. A halting
 * error (credit/auth) pauses that workspace's research scope exactly like the
 * research runner does, and the rest of its entries are skipped: every further
 * search would fail identically.
 */
export async function runDomainBackfillBatch(
  supabase: ReturnType<typeof createServerClient>,
  entries: DomainBackfillEntry[],
): Promise<{ resolved: number; no_match: number; errors: number; paused_workspaces: string[] }> {
  let resolved = 0, no_match = 0, errors = 0;
  const paused = new Set<string>();
  const keyByWs = new Map<string, string | null>();
  for (const e of entries) {
    if (paused.has(e.workspace_id)) continue;
    let key = keyByWs.get(e.workspace_id);
    if (key === undefined) {
      const policy = await getPolicy(supabase, e.workspace_id);
      key = resolveEnvVar(policy, 'EXA_API_KEY') ?? null;
      keyByWs.set(e.workspace_id, key);
    }
    if (!key) continue;
    const r = await resolveDomainViaSearch(supabase, {
      workspace_id: e.workspace_id,
      entity_id: e.entity_id,
      entity_name: e.entity_name,
      exa_api_key: key,
      actor_id: 'domain_backfill',
    });
    if (r.status === 'resolved') resolved++;
    else if (r.status === 'no_match') no_match++;
    else if (r.status === 'search_error') {
      errors++;
      if (isHaltingError(r.error)) {
        paused.add(e.workspace_id);
        const credit = /credit|402|payment/i.test(r.error ?? '');
        await setPipelineStatus(supabase, e.workspace_id, {
          state: 'paused',
          scope: 'research',
          provider: 'exa',
          reason: credit
            ? 'Exa (web research) is out of credit. Research is paused; scoring, contact pulls, and drafting continue. Add credits at dashboard.exa.ai, then click Continue.'
            : `Exa (web research) returned an error and research is paused: ${(r.error ?? '').slice(0, 140)}. Fix it, then click Continue.`,
          paused_at: new Date().toISOString(),
        });
      }
    }
    // 'already_has_domain': another path resolved it since the scan — nothing to do.
  }
  return { resolved, no_match, errors, paused_workspaces: [...paused] };
}

/**
 * domain-backfill-daily: one run per day that first resolves whatever it can
 * for free from contacts' corporate emails (backfillAccountDomainsFromContactEmails,
 * every workspace, no spend, no daily cap — it only shrinks what's left), then
 * works through up to policy.research.domain_backfill_per_day domainless
 * accounts per workspace via the guarded single-search resolver
 * (resolveDomainViaSearch — same precision rules, cheap snippet params).
 *
 * Why a dedicated pass: resolution otherwise only happens lazily when the
 * research dispatcher happens to pick an entity, so a book imported without
 * domains (the Sudden CSV: ~90% domainless) stays blind to own-site research
 * and contact lookups for months. This clears the backlog at an explicit,
 * operator-set pace instead.
 *
 * The internal batching keeps Inngest cost flat: a 75-entity day is ~6
 * executions (1 free pass + 1 scan + 5 resolve batches), not 75.
 */
export const domainBackfillDaily = inngest.createFunction(
  { id: 'domain-backfill-daily' },
  { cron: '0 11 * * *' }, // daily at 11:00 UTC, ahead of the noon sweeps and the 14:30 advance pass
  async ({ step }) => {
    // Free pass first: an account whose contact list has since grown a
    // corporate email (Hunter pull, CSV re-import, manual add) gets its domain
    // from that email at zero cost, same precision guard as the paid path.
    // Runs for every workspace regardless of domain_backfill_per_day — no Exa
    // key or spend budget involved, so there is no reason to gate it. This
    // only shrinks what the paid scan below has to spend credits on.
    const freeResolved = await step.run('free-email-backfill', async () => {
      const supabase = createServerClient();
      const { data: workspaces } = await supabase.from('workspaces').select('id');
      let domains_set = 0;
      for (const ws of (workspaces ?? []) as Array<{ id: string }>) {
        try {
          const r = await backfillAccountDomainsFromContactEmails(supabase, { workspace_id: ws.id });
          domains_set += r.domains_set;
        } catch { /* one workspace's failure shouldn't block the rest */ }
      }
      return domains_set;
    });

    const candidates = await step.run('scan-missing-domains', async () =>
      scanDomainBackfillCandidates(createServerClient()));
    if (!candidates.length) return { free_resolved: freeResolved, candidates: 0, resolved: 0, no_match: 0, errors: 0 };

    const batchSize = Math.ceil(candidates.length / DOMAIN_BACKFILL_BATCHES);
    const totals = { resolved: 0, no_match: 0, errors: 0 };
    const pausedWs = new Set<string>();
    for (let b = 0; b < DOMAIN_BACKFILL_BATCHES; b++) {
      const batch = candidates
        .slice(b * batchSize, (b + 1) * batchSize)
        .filter((c) => !pausedWs.has(c.workspace_id));
      if (!batch.length) continue;
      const r = await step.run(`resolve-batch-${b}`, async () =>
        runDomainBackfillBatch(createServerClient(), batch));
      totals.resolved += r.resolved;
      totals.no_match += r.no_match;
      totals.errors += r.errors;
      for (const w of r.paused_workspaces) pausedWs.add(w);
    }
    return { free_resolved: freeResolved, candidates: candidates.length, ...totals };
  },
);

/**
 * alias-backfill-daily: read the other names each account's coverage runs under.
 *
 * Same shape and reasoning as the domain backfill above. Resolution otherwise
 * only happens when the research dispatcher happens to pick an account, so every
 * account imported before this existed stays blind: the name gate keeps dropping
 * real articles about any company the press calls by its product name, and the
 * account reads as having no coverage rather than as misconfigured.
 *
 * Paced by policy.research.alias_backfill_per_day (0/unset = off) because each
 * account costs one Exa search plus one model call. Skips workspaces paused for
 * research, and pauses one that hits a credit wall mid-run exactly like the
 * domain path does.
 */
export const aliasBackfillDaily = inngest.createFunction(
  { id: 'alias-backfill-daily' },
  { cron: '30 11 * * *' }, // 30m after the domain backfill: an account resolved there is eligible here today
  async ({ step }) => {
    const workspaces = await step.run('scan-workspaces', async () => {
      const supabase = createServerClient();
      const { data } = await supabase.from('workspaces').select('id');
      const eligible: Array<{ id: string; per_day: number; key: string }> = [];
      for (const ws of (data ?? []) as Array<{ id: string }>) {
        const policy = await getPolicy(supabase, ws.id);
        const perDay = Math.floor(policy.research?.alias_backfill_per_day ?? 0);
        if (perDay <= 0) continue;
        const key = resolveEnvVar(policy, 'EXA_API_KEY');
        if (!key) continue;
        const pipe = await getPipelineStatus(supabase, ws.id);
        if (pipe?.state === 'paused' && (pipe.scope ?? 'all') !== 'contacts') continue;
        eligible.push({ id: ws.id, per_day: perDay, key });
      }
      return eligible;
    });
    if (!workspaces.length) return { workspaces: 0, resolved: 0, skipped: 0, errors: 0 };

    const totals = { resolved: 0, skipped: 0, errors: 0 };
    for (const ws of workspaces) {
      const r = await step.run(`aliases-${ws.id}`, async () => {
        const supabase = createServerClient();
        const res = await backfillAliases(supabase, {
          workspace_id: ws.id,
          exa_api_key: ws.key,
          limit: ws.per_day,
          actor_id: 'alias_backfill',
        });
        const halting = res.errors.find((e) => isHaltingError(e));
        if (halting) {
          const credit = /credit|402|payment/i.test(halting);
          await setPipelineStatus(supabase, ws.id, {
            state: 'paused',
            scope: 'research',
            provider: 'exa',
            reason: credit
              ? 'Exa (web research) is out of credit. Research is paused; scoring, contact pulls, and drafting continue. Add credits at dashboard.exa.ai, then click Continue.'
              : `Exa (web research) returned an error and research is paused: ${halting.slice(0, 140)}. Fix it, then click Continue.`,
            paused_at: new Date().toISOString(),
          });
        }
        return res;
      });
      totals.resolved += r.resolved;
      totals.skipped += r.skipped;
      totals.errors += r.failed;
    }
    return { workspaces: workspaces.length, ...totals };
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
