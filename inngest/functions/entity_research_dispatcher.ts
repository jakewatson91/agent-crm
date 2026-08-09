/**
 * Score-tiered research dispatcher.
 *
 * Every 4h, walks every account entity and decides whether enough time has
 * elapsed since the last research run to merit another. Tier determines
 * cadence; tier is driven by score_total (rolled-up ICP+signal score) with
 * score_signal_strength as an independent override and engagement as a
 * second override.
 *
 *   Hot     — score_total ≥ 0.5 OR signal_strength ≥ 0.7 OR engaged → every 24h
 *   Default — score_total ∈ [0.3, 0.5) → every 7d
 *   Cold    — score_total < 0.3       → every 30d
 *   Suppressed — dropped_until in the future → never
 *
 * Yield backoff: an already-researched account whose signal stays weak (research keeps
 * finding nothing usable) has its cadence stretched 2-3x, so spend follows yield rather
 * than paper ICP fit. Engaged / live-signal accounts are exempt and it resets on a yield.
 *
 * Accounts with no resolved attributes.domain never become candidates, tier
 * aside — no domain means no own_site angle and no contact pull afterward,
 * so a search there is spend with no possible payoff. domain-backfill-daily
 * (system_tasks.ts) resolves domains on its own cadence; once one lands, the
 * account is a normal candidate on its next due cycle.
 *
 * Among the "due" accounts, a per-workspace Exa search budget is split across three
 * selection buckets so we don't only ever re-research what we already know:
 *   high_value (exploit)  — top score, deep (all strategy angles)
 *   active_comms          — accounts mid-conversation, kept fresh
 *   exploration (explore) — a random sample of never-researched accounts, 1 cheap angle
 * A signal found in exploration raises that account's score → it graduates into
 * high_value next cycle. Budget + mix live on workspaces.policy.research.
 *
 * Emits `research.requested` (consumed by researchRunner) with `tier` + `angle_count`.
 * Writes `research_triggered` as the dispatch marker so subsequent ticks see the
 * cooldown even before researchRunner finishes.
 */
import { createServerClient } from '@agent-crm/db';
import {
  entityIdsOfType, recordActivityMarker, latestMarkerByEntity, ACTIVITY_MARKERS,
  getPolicy, getPipelineStatus, setPipelineStatus, ensureResearchStrategy, DEFAULT_RESEARCH_SEARCHES_PER_RUN, DEFAULT_SELECTION_MIX,
  RESEARCH_DISPATCH_CRON, runExaSearch, resolveEnvVar, resolveContactStrategy, DEFAULT_THRESHOLDS,
} from '@agent-crm/tools';
import { inngest } from '../client.ts';

// PostgREST builds `.in(col, ids)` into the request URL. Past a few hundred ids
// the URL exceeds the server limit and the request silently returns 0 rows with
// NO error — which previously made this dispatcher load zero scores/engagement
// and mis-tier every account as cold. Chunk every large-id `.in()` through this.
const IN_CHUNK = 200;
async function chunkedIn<T>(
  ids: string[],
  run: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const { data, error } = await run(ids.slice(i, i + IN_CHUNK));
    if (error) throw new Error(error.message);
    if (data) out.push(...data);
  }
  return out;
}

const TIER_CADENCE_HOURS = { hot: 24, default: 24 * 7, cold: 24 * 30 } as const;
const HOT_ICP_THRESHOLD = 0.5;
const HOT_SIGNAL_THRESHOLD = 0.7;
const COLD_ICP_THRESHOLD = 0.3;
const ENGAGEMENT_WINDOW_DAYS = 14;
const MAX_HOT_ANGLES = 6;

type Tier = 'hot' | 'default' | 'cold';

interface Candidate {
  entity_id: string;
  entity_name: string;
  tier: Tier;
  last_research_at: number; // epoch ms; 0 if never
  score: number;            // score_total, for high_value ranking
  engaged: boolean;         // in the active-comms set
  under_covered: boolean;   // never researched -> exploration pool
}

interface Chosen { cand: Candidate; angle_count: number }

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = a[i] as T;
    a[i] = a[j] as T;
    a[j] = tmp;
  }
  return a;
}

function normalizeMix(mix?: { high_value?: number; active_comms?: number; exploration?: number }) {
  const m = { ...DEFAULT_SELECTION_MIX, ...(mix ?? {}) };
  const sum = m.high_value + m.active_comms + m.exploration;
  if (!(sum > 0)) return { ...DEFAULT_SELECTION_MIX };
  return { high_value: m.high_value / sum, active_comms: m.active_comms / sum, exploration: m.exploration / sum };
}

/**
 * Spend `budget` Exa searches across the three buckets, deduped so no account is
 * chosen twice. Each account costs `angle_count` searches (hot = all strategy angles;
 * default = 1; exploration forces 1 even on a cold account). Buckets fill to their
 * share, then a spill pass uses any leftover budget on the highest-value remainder.
 */
function selectByBuckets(
  candidates: Candidate[],
  opts: { budget: number; mix: { high_value: number; active_comms: number; exploration: number }; hotAngleCount: number },
): Chosen[] {
  const { budget, mix, hotAngleCount } = opts;
  const chosen = new Map<string, Chosen>();
  let spent = 0;

  const angleCount = (c: Candidate, forceExplore: boolean) =>
    forceExplore ? 1 : c.tier === 'hot' ? hotAngleCount : 1;

  const add = (c: Candidate, forceExplore: boolean): boolean => {
    if (chosen.has(c.entity_id)) return false;
    const need = angleCount(c, forceExplore);
    if (need <= 0) return false;
    if (spent + need > budget) return false;
    chosen.set(c.entity_id, { cand: c, angle_count: need });
    spent += need;
    return true;
  };

  const fill = (pool: Candidate[], target: number, forceExplore: boolean) => {
    let bucketSpent = 0;
    for (const c of pool) {
      if (bucketSpent >= target || spent >= budget) break;
      const before = spent;
      if (add(c, forceExplore)) bucketSpent += spent - before;
    }
  };

  const byScore = [...candidates].sort((a, b) => (b.score - a.score) || (a.last_research_at - b.last_research_at));
  const engagedPool = byScore.filter((c) => c.engaged);
  const explorePool = shuffle(candidates.filter((c) => c.under_covered));

  fill(byScore, Math.round(mix.high_value * budget), false);
  fill(engagedPool, Math.round(mix.active_comms * budget), false);
  fill(explorePool, Math.round(mix.exploration * budget), true);
  // Spill: don't leave budget on the table — fill remaining from highest value down.
  fill(byScore, budget, false);
  fill(explorePool, budget, true);

  return [...chosen.values()];
}

interface DispatchItem { workspace_id: string; entity_id: string; entity_name: string; tier: Tier | 'contact'; angle_count: number; kind?: 'account' | 'contact' }

/**
 * Core selection + dispatch logic, factored out so it can run either on the
 * 4h cron (all workspaces) or on demand for one workspace — the "run research
 * now" button and the Continue-after-pause flow both call this directly
 * instead of waiting for the next tick.
 */
/**
 * One cheap call to see whether a paused research provider is actually still
 * walled. Returns true when the provider answers, meaning the pause is stale.
 *
 * Deliberately conservative: only a provider we know how to probe can auto-clear.
 * An unknown provider, a manual pause (no provider set), or a missing key stays
 * paused for a human, because we have no way to test it.
 */
async function probeResearchProvider(
  supabase: ReturnType<typeof createServerClient>,
  workspace_id: string,
  provider: string | undefined,
): Promise<boolean> {
  if (provider !== 'exa') return false;
  try {
    const policy = await getPolicy(supabase, workspace_id);
    const key = resolveEnvVar(policy, 'EXA_API_KEY');
    if (!key) return false;
    const r = await runExaSearch(key, { query: 'test', num_results: 1, text_chars: 1 });
    return r.ok;
  } catch {
    return false;
  }
}

export async function runResearchDispatch(
  supabase: ReturnType<typeof createServerClient>,
  opts?: { workspaceIds?: string[] },
) {
  const now = Date.now();
  const engagementSince = new Date(now - ENGAGEMENT_WINDOW_DAYS * 86400 * 1000).toISOString();

  const wsQuery = supabase.from('workspaces').select('id');
  const wsRes = opts?.workspaceIds?.length ? await wsQuery.in('id', opts.workspaceIds) : await wsQuery;
  const workspaces = (wsRes.data ?? []) as Array<{ id: string }>;

  const dispatch: DispatchItem[] = [];
  const by_tier = { hot: 0, default: 0, cold: 0 };
  let total_evaluated = 0;
  let skipped_suppressed = 0;
  let due_total = 0;
  let skipped_capped = 0;
  let skipped_no_domain = 0;
  let skipped_paused = 0;
  let auto_cleared_pauses = 0;
  let contacts_eligible = 0;
  let contacts_dispatched = 0;

  for (const ws of workspaces) {
    // A standing pause that covers research (scope 'research' or 'all')
    // means the runner would refuse every dispatch — skip the workspace
    // instead of queueing runs that no-op.
    const pipeStatus = await getPipelineStatus(supabase, ws.id);
    if (pipeStatus?.state === 'paused' && (pipeStatus.scope ?? 'all') !== 'contacts') {
      // A provider-triggered pause is a guess about the future: "this wall will
      // still be there." Test the guess instead of trusting it forever. One cheap
      // search per tick; if it succeeds the wall is gone, so clear the pause and
      // carry on with this workspace in the same run.
      //
      // Without this the pause can never clear itself: the runner returns early
      // on a standing pause, so it never calls the provider, so no error or
      // success is ever recorded. Topping up credit did nothing until someone
      // clicked Continue. Auto-clearing is the reversible-change path (act and
      // notify); the operator still sees the banner history.
      const cleared = await probeResearchProvider(supabase, ws.id, pipeStatus.provider);
      if (!cleared) { skipped_paused++; continue; }
      await setPipelineStatus(supabase, ws.id, {
        state: 'ok', last_run_at: pipeStatus.last_run_at, last_run: pipeStatus.last_run,
      });
      // Workspace-level, not entity-level, so this goes straight to the event log
      // rather than through recordActivityMarker (which is keyed to an entity).
      await supabase.from('events').insert({
        workspace_id: ws.id,
        actor_kind: 'system',
        actor_id: 'research_dispatcher',
        action: 'pipeline_auto_resumed',
        target_kind: 'workspace',
        target_id: ws.id,
        payload: {
          provider: pipeStatus.provider ?? null,
          prior_reason: pipeStatus.reason ?? null,
          paused_at: pipeStatus.paused_at ?? null,
          summary: `${pipeStatus.provider ?? 'provider'} answered a probe search, so the research pause was cleared automatically`,
        },
      });
      auto_cleared_pauses++;
    }

    const allAcctIds = (await entityIdsOfType(supabase, ws.id, 'account')).slice(0, 5000);
    const accounts = await chunkedIn<{ id: string; name: string; attributes: Record<string, unknown> | null }>(allAcctIds, (chunk) =>
      supabase.from('entities').select('id, name, attributes').in('id', chunk));
    if (!accounts.length) continue;
    total_evaluated += accounts.length;
    const acctIds = accounts.map((a) => a.id);
    const domainByEntity = new Map(accounts.map((a) => [a.id, typeof a.attributes?.domain === 'string' && a.attributes.domain.length > 0]));

    // Batched fact load — score + lifecycle predicates, in one query.
    const factRows = await chunkedIn<{ subject_entity: string; predicate: string; object_text: string | null; observed_at: string }>(
      acctIds,
      (chunk) => supabase
        .from('facts')
        .select('subject_entity, predicate, object_text, observed_at')
        .eq('workspace_id', ws.id)
        .in('subject_entity', chunk)
        .in('predicate', ['icp_fit', 'score_total', 'score_signal_strength', 'dropped_until'])
        .is('supersedes', null),
    );

    const lastResearchByEntity = await latestMarkerByEntity(supabase, ws.id, acctIds, [
      ACTIVITY_MARKERS.RESEARCH_TRIGGERED, ACTIVITY_MARKERS.RESEARCH_COMPLETED,
    ]);

    interface EntityState {
      score_total: number | null;
      signal_strength: number | null;
      dropped_until: string | null;
      last_research_at: number;
    }
    const stateByEntity = new Map<string, EntityState>();
    for (const a of accounts) {
      stateByEntity.set(a.id, {
        score_total: null, signal_strength: null, dropped_until: null,
        last_research_at: lastResearchByEntity.get(a.id) ?? 0,
      });
    }
    for (const f of factRows) {
      const s = stateByEntity.get(f.subject_entity);
      if (!s) continue;
      if (f.predicate === 'score_total') {
        const v = parseFloat(f.object_text ?? '');
        if (Number.isFinite(v)) s.score_total = v;
      } else if (f.predicate === 'icp_fit') {
        if (s.score_total === null) {
          const v = parseFloat(f.object_text ?? '');
          if (Number.isFinite(v)) s.score_total = v;
        }
      } else if (f.predicate === 'score_signal_strength') {
        const v = parseFloat(f.object_text ?? '');
        if (Number.isFinite(v)) s.signal_strength = v;
      } else if (f.predicate === 'dropped_until') {
        s.dropped_until = f.object_text ?? null;
      }
    }

    // Engagement detection: open touch_draft/outcome posts, approved gates,
    // replied touches — all within the engagement window.
    const engaged = new Set<string>();
    const channels = await chunkedIn<{ id: string; account_entity_id: string }>(acctIds, (chunk) =>
      supabase.from('channels').select('id, account_entity_id')
        .eq('workspace_id', ws.id).in('account_entity_id', chunk));
    const entityByChannel = new Map(channels.map((c) => [c.id, c.account_entity_id]));
    const channelIds = channels.map((c) => c.id);

    if (channelIds.length) {
      const engagementPosts = await chunkedIn<{ channel_id: string; id: string }>(channelIds, (chunk) =>
        supabase.from('channel_posts').select('channel_id, id, kind, created_at')
          .in('channel_id', chunk)
          .in('kind', ['touch_draft', 'outcome'])
          .gte('created_at', engagementSince));
      for (const p of engagementPosts) {
        const eid = entityByChannel.get(p.channel_id);
        if (eid) engaged.add(eid);
      }

      const allPosts = await chunkedIn<{ id: string; channel_id: string }>(channelIds, (chunk) =>
        supabase.from('channel_posts').select('id, channel_id').in('channel_id', chunk));
      if (allPosts.length) {
        const postToChannel = new Map(allPosts.map((p) => [p.id, p.channel_id]));
        const gateRows = await chunkedIn<{ channel_post_id: string }>(allPosts.map((p) => p.id), (chunk) =>
          supabase.from('gates').select('channel_post_id, decision, decided_at')
            .in('channel_post_id', chunk)
            .eq('decision', 'approve')
            .gte('decided_at', engagementSince));
        for (const g of gateRows) {
          const cid = postToChannel.get(g.channel_post_id);
          const eid = cid ? entityByChannel.get(cid) : undefined;
          if (eid) engaged.add(eid);
        }
      }
    }

    const touchRes = await supabase
      .from('touches').select('contact_entity_id, status, sent_at')
      .eq('workspace_id', ws.id).eq('status', 'replied')
      .gte('sent_at', engagementSince);
    const repliedContacts = ((touchRes.data ?? []) as Array<{ contact_entity_id: string }>)
      .map((t) => t.contact_entity_id);
    if (repliedContacts.length) {
      const worksAtRows = await chunkedIn<{ object_entity: string | null }>(repliedContacts, (chunk) =>
        supabase.from('facts').select('subject_entity, object_entity')
          .eq('workspace_id', ws.id).eq('predicate', 'works_at')
          .is('supersedes', null).in('subject_entity', chunk));
      for (const f of worksAtRows) {
        if (f.object_entity && stateByEntity.has(f.object_entity)) engaged.add(f.object_entity);
      }
    }

    // Tier each entity; keep only those whose cadence cooldown has elapsed ("due").
    const candidates: Candidate[] = [];
    for (const a of accounts) {
      const s = stateByEntity.get(a.id)!;
      if (s.dropped_until) {
        const until = Date.parse(s.dropped_until);
        if (Number.isFinite(until) && until > now) { skipped_suppressed++; continue; }
      }
      if (!domainByEntity.get(a.id)) { skipped_no_domain++; continue; }
      let tier: Tier;
      if (engaged.has(a.id) || (s.signal_strength ?? 0) >= HOT_SIGNAL_THRESHOLD || (s.score_total ?? 0) >= HOT_ICP_THRESHOLD) {
        tier = 'hot';
      } else if ((s.score_total ?? 0) >= COLD_ICP_THRESHOLD) {
        tier = 'default';
      } else {
        tier = 'cold';
      }
      // Yield-based backoff: an account we've already researched that still has a weak
      // signal (high ICP fit but research keeps finding nothing usable — the NHL case)
      // waits longer between passes, so search spend follows yield, not paper fit.
      // Engaged accounts and ones with a live signal never back off, and the multiplier
      // returns to 1 the moment a pass lifts the signal. sig<0.3 -> 3x, sig<0.5 -> 2x.
      const sig = s.signal_strength ?? 0;
      const backoff = (s.last_research_at > 0 && !engaged.has(a.id) && sig < 0.5) ? (sig < 0.3 ? 3 : 2) : 1;
      const cadenceMs = TIER_CADENCE_HOURS[tier] * backoff * 3600 * 1000;
      if (s.last_research_at && now - s.last_research_at < cadenceMs) continue;
      candidates.push({
        entity_id: a.id, entity_name: a.name, tier,
        last_research_at: s.last_research_at,
        score: s.score_total ?? 0,
        engaged: engaged.has(a.id),
        under_covered: s.last_research_at === 0,
      });
    }
    due_total += candidates.length;
    if (!candidates.length) continue;

    // Strategy (lazily generated + cached) sets how deep a hot account goes.
    const angles = await ensureResearchStrategy(supabase, ws.id);
    const hotAngleCount = Math.min(Math.max(angles.length, 1), MAX_HOT_ANGLES);

    const policy = await getPolicy(supabase, ws.id);
    const totalBudget = policy.research?.searches_per_run ?? DEFAULT_RESEARCH_SEARCHES_PER_RUN;
    // Contact-signal search (what linked PEOPLE have posted, not the company)
    // is carved off the top of this SAME budget, not a second pool -- total
    // spend per tick is unchanged, some of it is redirected. 0/unset = off,
    // so no existing workspace's spend changes until this is turned on.
    const contactShare = Math.max(0, Math.min(1, policy.research?.contact_signal_share ?? 0));
    const contactBudget = Math.round(contactShare * totalBudget);
    const budget = totalBudget - contactBudget;
    const mix = normalizeMix(policy.research?.selection_mix);

    const chosen = selectByBuckets(candidates, { budget, mix, hotAngleCount });
    skipped_capped += candidates.length - chosen.length;
    for (const c of chosen) {
      by_tier[c.cand.tier]++;
      dispatch.push({
        workspace_id: ws.id,
        entity_id: c.cand.entity_id,
        entity_name: c.cand.entity_name,
        tier: c.cand.tier,
        angle_count: c.angle_count,
        kind: 'account',
      });
    }

    // --- Contact-signal candidates: linked people at accounts that already
    // cleared the score bar, ranked by their account's score (exploit only,
    // no explore bucket). At today's real contact volumes -- low hundreds
    // per workspace, capped further by MAX_CONTACTS_PER_ACCOUNT -- a full
    // bucketed explore/exploit split (like accounts get above) is more
    // machine than the problem needs: a plain rotation on a fixed cadence
    // covers every eligible contact with budget to spare. If contact volume
    // ever outgrows that, extend this with selectByBuckets the same way
    // accounts already work above.
    if (contactBudget > 0) {
      const contactIcpBar = policy.research?.contact_signal_account_icp
        ?? policy.routing?.enrich_contacts_account_icp
        ?? DEFAULT_THRESHOLDS.ENRICH_CONTACTS_ACCOUNT_ICP;
      const cadenceMs = (policy.research?.contact_signal_cadence_days ?? 3) * 86400 * 1000;
      const contactAngleCount = resolveContactStrategy(policy.research?.contact_signal_max_age_days ?? 60).length;

      const allContactIds = (await entityIdsOfType(supabase, ws.id, 'contact')).slice(0, 5000);
      if (allContactIds.length) {
        const worksAtRows = await chunkedIn<{ subject_entity: string; object_entity: string | null }>(allContactIds, (chunk) =>
          supabase.from('facts').select('subject_entity, object_entity')
            .eq('workspace_id', ws.id).eq('predicate', 'works_at').is('supersedes', null)
            .in('subject_entity', chunk));
        const accountByContact = new Map<string, string>();
        for (const r of worksAtRows) if (r.object_entity) accountByContact.set(r.subject_entity, r.object_entity);
        const linkedContactIds = [...accountByContact.keys()];

        if (linkedContactIds.length) {
          const [contactEnts, lastContactResearch] = await Promise.all([
            chunkedIn<{ id: string; name: string }>(linkedContactIds, (chunk) =>
              supabase.from('entities').select('id, name').in('id', chunk)),
            latestMarkerByEntity(supabase, ws.id, linkedContactIds, [
              ACTIVITY_MARKERS.RESEARCH_TRIGGERED, ACTIVITY_MARKERS.RESEARCH_COMPLETED,
            ]),
          ]);
          const nameById = new Map(contactEnts.map((e) => [e.id, e.name]));

          const eligible = linkedContactIds
            .map((cid) => {
              const accountId = accountByContact.get(cid)!;
              return {
                entity_id: cid,
                entity_name: nameById.get(cid) ?? '(unknown)',
                account_score: stateByEntity.get(accountId)?.score_total ?? 0,
                last_research_at: lastContactResearch.get(cid) ?? 0,
              };
            })
            .filter((c) => c.account_score >= contactIcpBar && now - c.last_research_at >= cadenceMs)
            .sort((a, b) => b.account_score - a.account_score);
          contacts_eligible += eligible.length;

          let contactSpent = 0;
          for (const c of eligible) {
            if (contactSpent + contactAngleCount > contactBudget) break;
            contactSpent += contactAngleCount;
            contacts_dispatched++;
            dispatch.push({
              workspace_id: ws.id,
              entity_id: c.entity_id,
              entity_name: c.entity_name,
              tier: 'contact',
              angle_count: contactAngleCount,
              kind: 'contact',
            });
          }
        }
      }
    }
  }

  let dispatch_errors = 0;
  for (const d of dispatch) {
    const actor = { workspace_id: d.workspace_id, actor_kind: 'system' as const, actor_id: 'entity_research_dispatcher' };
    try {
      await recordActivityMarker(supabase, actor, ACTIVITY_MARKERS.RESEARCH_TRIGGERED, d.entity_id, { tier: d.tier });
      await inngest.send({
        name: 'research.requested',
        data: {
          workspace_id: d.workspace_id,
          entity_id: d.entity_id,
          entity_name: d.entity_name,
          reason: `dispatcher:${d.tier}`,
          tier: d.tier,
          angle_count: d.angle_count,
          kind: d.kind ?? 'account',
        },
      });
    } catch {
      dispatch_errors++;
    }
  }

  return {
    dispatched: dispatch.length - dispatch_errors,
    by_tier,
    total_evaluated,
    due: due_total,
    skipped_capped,
    skipped_suppressed,
    skipped_no_domain,
    skipped_paused,
    auto_cleared_pauses,
    dispatch_errors,
    contacts_eligible,
    contacts_dispatched,
  };
}

export const entityResearchDispatcher = inngest.createFunction(
  { id: 'entity-research-dispatcher' },
  { cron: RESEARCH_DISPATCH_CRON },
  async ({ step }) => step.run('dispatch-batch', () => runResearchDispatch(createServerClient())),
);
