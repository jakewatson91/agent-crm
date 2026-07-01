/**
 * Pure agent logic: load context -> pre-LLM checks -> LLM -> structured action -> tool dispatch.
 *
 * Branches on subscription.agent_behavior:
 *   - 'claim_poster' (default): produces post_claim or request_gate
 *   - 'drafter':                  produces post_touch_draft (email-shaped) or request_gate
 *
 * Provider routing (see primitives/model_registry.ts): the model id decides.
 *   - "deepseek/<model>" (or bare) -> DeepSeek direct (api.deepseek.com)
 *   - "<vendor>/<model>"           -> Vercel AI Gateway (one AI_GATEWAY_API_KEY,
 *                                     covers Anthropic/OpenAI/Google/...)
 *
 * Prompt cache discipline: the system message contains ONLY workspace-stable
 * content (about, constitution, decision instructions, output format). Per-run
 * variable content (agent identity, signal, facts) goes in the user message.
 * That means OpenAI's prompt cache hits on the system message across many runs
 * in the same workspace — ~50% input-token discount on the cached portion.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { callTool, pastOutcomes as pastOutcomesFn, findContacts as findContactsFn, linkContactToAccount as linkContactFn, scoreAndAssert as scoreAndAssertFn, selectAction, buildThresholds, loadActionContext, loadBestContactScore, chatCompleteForWorkspace, buildDrafterDecision, renderAttributesProse, scoreFacts, setOutreachStage, resolveOrCreateEntity, looksLikeEntityName, recordActivityMarker, ACTIVITY_MARKERS, resolveQualification, isSubstantiveFact, type WorkspacePolicy, type FactScore } from '@agent-crm/tools';
// chatComplete is wrapped via chatCompleteForWorkspace from @agent-crm/tools.
import { createHash } from 'node:crypto';
import { inngest } from '../client.js';

// Default routing: every behavior except drafter uses Flash. Drafter is the
// user-visible output — pay for Pro quality. Both go to DeepSeek direct
// (api.deepseek.com, DEEPSEEK_API_KEY).
const DEFAULT_MODEL = 'deepseek-v4-flash';
const DRAFTER_MODEL = 'deepseek-v4-pro';

type AgentBehavior = 'claim_poster' | 'drafter' | 'enricher';

export interface AgentRunPayload {
  workspace_id: string;
  agent: string;
  subscription_id?: string;
  signal_id?: string;
  fact_id?: string;     // present for fact-triggered runs (parallel to signal_id)
  parent_event_id?: string;
}

export interface AgentRunResult {
  ok: boolean;
  action: 'post_claim' | 'post_touch_draft' | 'request_gate' | 'enrich' | 'skip';
  channel_post_id?: string;
  gate_id?: string;
  facts_asserted?: number;          // enricher: how many facts created
  reason?: string;
  llm_input_tokens?: number;
  llm_output_tokens?: number;
  llm_cached_input_tokens?: number;
  llm_provider?: string;
  llm_model?: string;
  behavior?: AgentBehavior;
}

export async function runAgent(
  supabase: SupabaseClient,
  payload: AgentRunPayload,
): Promise<AgentRunResult> {
  if (!payload.signal_id && !payload.fact_id) return { ok: false, action: 'skip', reason: 'need signal_id or fact_id to run' };

  // 1. Trigger context: signal OR fact. The downstream prompt builder treats them
  // similarly — both describe "what changed about this entity that prompted the run."
  let triggerEntity: string;
  let sigData: { id: string; entity_id: string; type: string; magnitude: number; body_for_embedding: string; observed_at: string; structured_tags: any } | null = null;
  // signalCreatedEventId: the event id of the signal.created event. Threaded
  // as parent_event_id into every downstream tool call so the resulting
  // assert_fact / post_to_channel events chain back to the originating signal.
  // The audit-side chain/batch routes walk this link to surface the source URL.
  let signalCreatedEventId: string | null = null;
  if (payload.signal_id) {
    const sig = await supabase
      .from('signals')
      .select('id, entity_id, type, magnitude, body_for_embedding, observed_at, structured_tags')
      .eq('id', payload.signal_id).single();
    if (sig.error || !sig.data) return { ok: false, action: 'skip', reason: `signal ${payload.signal_id} not found` };
    sigData = sig.data as unknown as typeof sigData;
    triggerEntity = sig.data.entity_id;
    const sigEv = await supabase
      .from('events')
      .select('id')
      .eq('workspace_id', payload.workspace_id)
      .eq('target_kind', 'signal')
      .eq('target_id', payload.signal_id)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (sigEv.data?.id != null) signalCreatedEventId = String(sigEv.data.id);
  } else {
    // Fact-triggered: synthesize a signal-shaped payload describing the fact change.
    const fact = await supabase.from('facts')
      .select('id, subject_entity, predicate, object_text, confidence, observed_at')
      .eq('id', payload.fact_id!).single();
    if (fact.error || !fact.data) return { ok: false, action: 'skip', reason: `fact ${payload.fact_id} not found` };
    triggerEntity = fact.data.subject_entity as string;
    sigData = {
      id: fact.data.id as string,
      entity_id: triggerEntity,
      type: `fact_change:${fact.data.predicate}`,
      magnitude: 0.7,
      body_for_embedding: `Fact change: ${fact.data.predicate}=${fact.data.object_text}`,
      observed_at: fact.data.observed_at as string,
      structured_tags: { signal_source: 'fact_trigger', predicate: fact.data.predicate, object_text: fact.data.object_text, confidence: fact.data.confidence },
    };
  }

  const ent = await supabase
    .from('entities').select('id, name, attributes')
    .eq('id', triggerEntity).single();
  if (ent.error || !ent.data) return { ok: false, action: 'skip', reason: `entity ${triggerEntity} not found` };

  // 2. Active facts.
  const allFacts = await supabase
    .from('facts')
    .select('id, predicate, object_text, confidence, supersedes, created_at, observed_at, source_event_id')
    .eq('subject_entity', ent.data.id);
  if (allFacts.error) return { ok: false, action: 'skip', reason: `facts query failed: ${allFacts.error.message}` };
  const factRows = (allFacts.data ?? []) as Array<{ id: string; predicate: string; object_text: string | null; confidence: number; supersedes: string | null; created_at: string; observed_at: string; source_event_id: number | null }>;
  const supersededIds = new Set(factRows.map((f) => f.supersedes).filter((x): x is string => !!x));
  const activeFacts = factRows.filter((f) => !supersededIds.has(f.id));

  // 3. Workspace.
  const ws = await supabase
    .from('workspaces')
    .select('persona, icp, policy, budget_cents, constitution, about')
    .eq('id', payload.workspace_id).single();
  if (ws.error || !ws.data) return { ok: false, action: 'skip', reason: 'workspace not found' };
  const policy = (ws.data.policy ?? {}) as WorkspacePolicy;
  const constitution = ((ws.data.constitution as string) ?? '').trim();
  const about = ((ws.data.about as string) ?? '').trim();
  // Per-workspace banned phrases stack on top of the code-level defaults.
  const extraBanned = (policy.outreach?.banned_phrases ?? []).filter((s) => typeof s === 'string' && s.trim().length > 0);
  const sanitize = (s: string) => sanitizeText(s, extraBanned);

  // 4. Subscription metadata + behavior + model.
  let subName = '(unknown)';
  let subSemantic = '(unknown)';
  let behavior: AgentBehavior = 'claim_poster';
  let model: string = DEFAULT_MODEL;
  if (payload.subscription_id) {
    const sub = await supabase
      .from('subscriptions')
      .select('name, semantic_query, agent_behavior, model')
      .eq('id', payload.subscription_id).maybeSingle();
    if (sub.data) {
      subName = (sub.data.name as string) ?? subName;
      subSemantic = (sub.data.semantic_query as string) ?? subSemantic;
      behavior = ((sub.data.agent_behavior as AgentBehavior) ?? 'claim_poster');
      if (sub.data.model) model = sub.data.model as string;
    }
  }
  // If the subscription didn't pin a model and this is a drafter run, lift
  // to Pro. Drafter output is what the customer reads.
  if (model === DEFAULT_MODEL && behavior === 'drafter') model = DRAFTER_MODEL;

  // 5. Channel. Lazily create it if missing instead of skipping. Entities made via
  // resolveOrCreateEntity / create_entity (e.g. the ATS connector's company nodes)
  // get is_a=account but no channel, unlike the create_account tool which makes both.
  // Requiring a pre-existing channel here silently skipped enrichment for every such
  // account ("no channel for entity") — so the enricher asserted zero facts. Mirror
  // the post_to_channel SQL's `on conflict do nothing` with an idempotent upsert.
  let channel_id: string;
  const chan = await supabase
    .from('channels').select('id')
    .eq('workspace_id', payload.workspace_id).eq('account_entity_id', ent.data.id).maybeSingle();
  if (chan.data?.id) {
    channel_id = chan.data.id as string;
  } else {
    await supabase
      .from('channels')
      .upsert(
        { workspace_id: payload.workspace_id, account_entity_id: ent.data.id, title: (ent.data.name as string) ?? 'Account' },
        { onConflict: 'workspace_id,account_entity_id', ignoreDuplicates: true },
      );
    const rechan = await supabase
      .from('channels').select('id')
      .eq('workspace_id', payload.workspace_id).eq('account_entity_id', ent.data.id).maybeSingle();
    if (!rechan.data?.id) return { ok: false, action: 'skip', reason: 'channel create failed' };
    channel_id = rechan.data.id as string;
  }

  const actor = { workspace_id: payload.workspace_id, actor_kind: 'agent' as const, actor_id: payload.agent };

  // ============================================================
  // Pre-LLM deterministic checks. Each one that fires emits a `decision` post
  // (no gate) and returns. Gates are only for irreversible actions a human
  // must approve — see CLAUDE.md. Operational rejections by the agent itself
  // are audit-trail entries, not human work.
  // ============================================================

  // Enricher: skip if the entity has an active dropped_until fact. Mirrors the
  // same short-circuit in scoreAndAssert (packages/tools/src/scoring.ts) so
  // dropped entities don't burn LLM on either path. The drafter path goes
  // through action_selector which already respects this; the enricher path
  // dispatches directly and needs the explicit check here.
  if (behavior === 'enricher') {
    const dropRes = await supabase.from('facts')
      .select('object_text')
      .eq('workspace_id', payload.workspace_id)
      .eq('subject_entity', ent.data.id)
      .eq('predicate', 'dropped_until')
      .is('supersedes', null)
      .order('observed_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const dropUntil = (dropRes.data?.object_text as string | null) ?? null;
    if (dropUntil) {
      const t = Date.parse(dropUntil);
      if (Number.isFinite(t) && t > Date.now()) {
        await supabase.from('events').insert({
          workspace_id: payload.workspace_id,
          actor_kind: 'agent',
          actor_id: payload.agent,
          action: 'enrichment_skipped',
          target_kind: 'entity',
          target_id: ent.data.id,
          payload: {
            reason: 'entity_dropped',
            entity_id: ent.data.id,
            dropped_until: dropUntil,
            signal_id: payload.signal_id ?? null,
          },
          parent_event_id: payload.parent_event_id ?? null,
        });
        return { ok: true, action: 'skip', reason: 'entity_dropped', behavior };
      }
    }
  }

  // Enricher: skip re-enrichment when the same signal body has already been
  // observed for this entity in the last 7d. Catches YC-directory daily re-emit
  // pattern (identical hourly scrapes). We compare against the signals table
  // directly — not agent_run_metrics — so dedup fires on the very next signal,
  // not after the first successful run accrues a metrics event. The skip
  // outcome is an events row, not a channel_post, so the feed stays clean.
  let signalBodyHash: string | null = null;
  if (behavior === 'enricher' && sigData?.body_for_embedding && payload.signal_id) {
    const normalized = sigData.body_for_embedding.trim().toLowerCase().replace(/\s+/g, ' ');
    signalBodyHash = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
    const since7d = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
    const priorSignals = await supabase.from('signals')
      .select('id, body_for_embedding, observed_at')
      .eq('entity_id', ent.data.id)
      .neq('id', sigData.id)
      .lt('observed_at', sigData.observed_at)
      .gte('observed_at', since7d)
      .order('observed_at', { ascending: false })
      .limit(50);
    const priorMatch = (priorSignals.data ?? []).find((p) => {
      const pNorm = ((p.body_for_embedding as string | null) ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
      return createHash('sha256').update(pNorm).digest('hex').slice(0, 16) === signalBodyHash;
    });
    if (priorMatch) {
      await supabase.from('events').insert({
        workspace_id: payload.workspace_id,
        actor_kind: 'agent',
        actor_id: payload.agent,
        action: 'enrichment_skipped',
        target_kind: 'entity',
        target_id: ent.data.id,
        payload: {
          reason: 'duplicate_signal_body',
          entity_id: ent.data.id,
          current_signal_id: sigData.id,
          prior_signal_id: priorMatch.id,
          signal_body_hash: signalBodyHash,
        },
        parent_event_id: payload.parent_event_id ?? null,
      });
      return { ok: true, action: 'skip', reason: 'duplicate_signal_body', behavior };
    }
  }

  // Enricher: coalesce same-type bursts on one entity. A company with N open job
  // posts emits N distinct hiring_post signals (distinct bodies, so the dedup
  // above doesn't catch them); each would otherwise fire a full 13.5k-token LLM
  // enrich. When an earlier signal of the SAME type for this entity landed within
  // the coalesce window, the first run already captured the trend — skip the LLM
  // and record the skip as an events row (feed stays clean). Keyed on (entity,
  // signal type), so different signal types and different entities always run.
  // Config: policy.enrichment.coalesce_window_min (default 60, 0 disables).
  const coalesceMin = policy.enrichment?.coalesce_window_min ?? 60;
  if (behavior === 'enricher' && coalesceMin > 0 && sigData?.type && payload.signal_id && sigData.observed_at) {
    const windowStart = new Date(Date.parse(sigData.observed_at) - coalesceMin * 60_000).toISOString();
    const prior = await supabase.from('signals')
      .select('id')
      .eq('entity_id', ent.data.id)
      .eq('type', sigData.type)
      .neq('id', sigData.id)
      .lt('observed_at', sigData.observed_at)
      .gte('observed_at', windowStart)
      .order('observed_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (prior.data?.id) {
      await supabase.from('events').insert({
        workspace_id: payload.workspace_id,
        actor_kind: 'agent',
        actor_id: payload.agent,
        action: 'enrichment_skipped',
        target_kind: 'entity',
        target_id: ent.data.id,
        payload: {
          reason: 'coalesced_recent_enrich',
          entity_id: ent.data.id,
          signal_id: sigData.id,
          signal_type: sigData.type,
          prior_signal_id: prior.data.id,
          window_min: coalesceMin,
        },
        parent_event_id: payload.parent_event_id ?? null,
      });
      return { ok: true, action: 'skip', reason: 'coalesced_recent_enrich', behavior };
    }
  }

  // Per-entity enrichment cooldown. When any enricher run on this entity
  // succeeded (ok=true, facts asserted) within the cooldown window, skip —
  // the entity is already up to date. Prevents a high-volume ATS source from
  // re-enriching the same account on every new job posting.
  const entityCooldownHours = policy.enrichment?.entity_enrich_cooldown_hours ?? 20;
  if (behavior === 'enricher' && entityCooldownHours > 0) {
    const cooldownSince = new Date(Date.now() - entityCooldownHours * 3600_000).toISOString();
    const recentEnrich = await supabase.from('events')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', payload.workspace_id)
      .eq('action', 'agent_dispatch_result')
      .eq('target_kind', 'entity')
      .eq('target_id', ent.data.id)
      .eq('payload->>behavior', 'enricher')
      .gte('created_at', cooldownSince);
    if ((recentEnrich.count ?? 0) > 0) {
      return { ok: true, action: 'skip', reason: 'entity_enrich_cooldown', behavior };
    }
  }

  if (behavior === 'drafter') {
    // Workspace policy: hard suppression-list match. Orthogonal to scoring, so
    // it still lives here, not in action_selector.
    const suppression = policy.suppression_list ?? [];
    const entityDomain = ((ent.data.attributes as { domain?: string } | null)?.domain ?? '').toLowerCase();
    const entityName = (ent.data.name as string).toLowerCase();
    const suppressed = suppression.some((s) => {
      const t = s.toLowerCase();
      return entityDomain.includes(t) || entityName.includes(t) || ent.data.id === s;
    });
    if (suppressed) {
      await supabase.from('events').insert({
        workspace_id: payload.workspace_id,
        actor_kind: 'agent',
        actor_id: payload.agent,
        action: 'drafter_skipped',
        target_kind: 'entity',
        target_id: ent.data.id,
        payload: { reason: 'suppression_match', entity_id: ent.data.id, entity_name: ent.data.name },
        parent_event_id: payload.parent_event_id ?? null,
      });
      return { ok: true, action: 'skip', reason: 'suppression_match', behavior };
    }

    // Workspace policy: daily send cap. Same reasoning — not scoring-driven.
    const cap = policy.daily_send_cap;
    if (typeof cap === 'number' && cap >= 0) {
      const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
      const today = await supabase
        .from('channel_posts')
        .select('id', { count: 'exact', head: true })
        .eq('kind', 'touch_draft')
        .gte('created_at', startOfDay.toISOString());
      const usedToday = today.count ?? 0;
      if (usedToday >= cap) {
        await supabase.from('events').insert({
          workspace_id: payload.workspace_id,
          actor_kind: 'agent',
          actor_id: payload.agent,
          action: 'drafter_skipped',
          target_kind: 'entity',
          target_id: ent.data.id,
          payload: { reason: 'rate_limit_exceeded', used_today: usedToday, cap },
          parent_event_id: payload.parent_event_id ?? null,
        });
        return { ok: true, action: 'skip', reason: 'rate_limit_exceeded', behavior };
      }
    }

    // Scoring v2: rebuild the breakdown from the sub-score facts the scorer
    // most recently asserted on this entity. If the scorer has never run for
    // this entity (no `score_total` fact yet), we fall back to `icp_fit` as
    // icp_total with empty rubric — action_selector treats that as low
    // signal_strength and will route to deep_research or continue.
    function readScoreFact(predicate: string, fallback: number = 0): number {
      const f = activeFacts.find((x) => x.predicate === predicate);
      if (!f) return fallback;
      const v = parseFloat(f.object_text ?? '');
      return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback;
    }
    const scoreBreakdown = {
      industry_match: readScoreFact('score_industry_match'),
      stage_match: readScoreFact('score_stage_match'),
      signal_strength: readScoreFact('score_signal_strength'),
      evidence_depth: readScoreFact('score_evidence_depth'),
      recency: readScoreFact('score_recency'),
      graph_proximity: readScoreFact('score_graph_proximity'),
      rrf_prefilter: 0,
    };
    const icpTotal = readScoreFact('score_total', readScoreFact('icp_fit'));

    const ctx = await loadActionContext(supabase, payload.workspace_id, ent.data.id, channel_id);
    // Two-tier gate input: best contact_score over this account's contacts.
    // Undefined when no scored contacts → selectAction stays account-only.
    const bestContactScore = await loadBestContactScore(supabase, payload.workspace_id, ent.data.id);
    const thresholds = buildThresholds(policy.routing);
    const decision = selectAction({
      workspace_id: payload.workspace_id,
      entity_id: ent.data.id,
      breakdown: scoreBreakdown,
      icp_total: icpTotal,
      best_contact_score: bestContactScore,
      recent_draft_at: ctx.recent_draft_at,
      recent_research_at: ctx.recent_research_at,
      recent_contacts_request_at: ctx.recent_contacts_request_at,
      dropped_until: ctx.dropped_until,
      cooldown_until: ctx.cooldown_until,
      thresholds,
    });

    if (decision.action !== 'draft_outreach') {
      // Only post state-changing actions to the channel. watch_only and continue
      // produce no observable change, so they're audit-trail events only — the
      // feed stays focused on actions the user cares about.
      const cites = activeFacts.filter((f) => f.predicate.startsWith('score_')).map((f) => f.id);
      const STATE_CHANGING: ReadonlySet<typeof decision.action> = new Set(['deep_research', 'drop', 'enrich_contacts']);
      if (STATE_CHANGING.has(decision.action)) {
        await noteDecision(supabase, actor, channel_id, payload.parent_event_id,
          `[${decision.action}] ${decision.reason}`, cites);
      } else {
        await supabase.from('events').insert({
          workspace_id: payload.workspace_id,
          actor_kind: 'agent',
          actor_id: payload.agent,
          action: 'action_selector_skip',
          target_kind: 'entity',
          target_id: ent.data.id,
          payload: { action: decision.action, policy: decision.policy, reason: decision.reason },
          parent_event_id: payload.parent_event_id ?? null,
        });
      }

      if (decision.action === 'deep_research') {
        // Mark that we triggered research so we don't re-trigger every cron
        // tick. Action selector reads this via recent_research_at. This is a
        // record of what the system DID, not a fact about the account, so it
        // goes to the event log — writing it as a fact inflated evidence_depth
        // and recency in scoring.
        await recordActivityMarker(supabase, actor, ACTIVITY_MARKERS.RESEARCH_TRIGGERED, ent.data.id,
          { reason: decision.reason }, payload.parent_event_id);
        // Two research paths. High-fit accounts (icp_total >= min_icp, and the
        // workspace opted in) get the adaptive multi-step qualification loop —
        // it reasons step by step and is reserved for accounts worth the cost.
        // Everyone else gets the cheap fixed Exa fan-out (researchRunner). The
        // marker above gates re-firing of EITHER path via recent_research_at.
        const qual = resolveQualification(policy);
        const useQualLoop = qual.enabled && icpTotal >= qual.min_icp;
        try {
          if (useQualLoop) {
            await inngest.send({
              name: 'qualification.requested',
              data: {
                workspace_id: payload.workspace_id,
                entity_id: ent.data.id,
                entity_name: ent.data.name,
                reason: decision.reason,
              },
            });
          } else {
            // Fire the inngest event the source-runner will consume to pull more
            // facts via Exa scoped to this entity.
            await inngest.send({
              name: 'research.requested',
              data: {
                workspace_id: payload.workspace_id,
                entity_id: ent.data.id,
                entity_name: ent.data.name,
                reason: decision.reason,
                // Reactive deep-research is high-intent: run the full angle set.
                tier: 'hot',
              },
            });
          }
        } catch { /* non-fatal: next rescore tick can retry */ }
      } else if (decision.action === 'enrich_contacts') {
        // Mark the request so we don't re-fire every tick before the pull lands.
        // action_selector reads this via recent_contacts_request_at. Event-log
        // marker, not a fact (see research_triggered above).
        await recordActivityMarker(supabase, actor, ACTIVITY_MARKERS.CONTACTS_REQUESTED, ent.data.id,
          { reason: decision.reason }, payload.parent_event_id);
        // Fire the event the contacts-runner consumes to pull decision-makers
        // for this account via the workspace's configured contact provider.
        try {
          await inngest.send({
            name: 'contacts.requested',
            data: {
              workspace_id: payload.workspace_id,
              entity_id: ent.data.id,
              entity_name: ent.data.name,
              reason: decision.reason,
            },
          });
        } catch { /* non-fatal: next rescore tick can retry */ }
      } else if (decision.action === 'drop') {
        // Write a dropped_until fact 90d in the future. Action selector
        // checks this and short-circuits subsequent scoring runs.
        const until = new Date(Date.now() + 90 * 86400 * 1000).toISOString();
        await callTool(supabase, actor, 'assert_fact', {
          subject_entity: ent.data.id,
          predicate: 'dropped_until',
          object_text: until,
          confidence: 1.0,
        });
      }

      return { ok: true, action: 'skip', reason: decision.policy, behavior };
    }
    // Else: fall through to LLM-drafter below. action === 'draft_outreach'.
  }

  // ============================================================
  // Cache-friendly prompt structure:
  //   System message = stable across runs in this (workspace, behavior). Caches.
  //   User message   = per-run variable content (agent identity, signal, facts).
  // ============================================================
  // Drafters get past gate decisions + linked contacts in their context. Other
  // behaviors (claim_poster, enricher) don't need either — they're not making
  // judgment calls about who to send to.
  let pastOutcomesList: Array<{ entity_name: string; gate_policy: string; decision: string; decided_at: string; similarity: number | null; resolution: Record<string, unknown> }> = [];
  let contacts: Array<{ name: string; email: string; role: string }> = [];
  if (behavior === 'drafter') {
    // Hunter pre-flight: fetch contacts here, not during enrichment. The
    // enricher fires on every signal; the drafter fires only when the agent
    // already decided to message this account. Looking up contacts at draft
    // time means we burn Hunter credits ~1 per outbound, not ~1 per fact-yielding
    // signal. Subject to policy.enrichment.hunter_monthly_cap (enforced inside
    // maybeLinkContactsForEntity).
    if (policy.enrichment?.contact_provider === 'hunter' && process.env.HUNTER_API_KEY) {
      // Pre-LLM, so prompt_hash isn't known yet; thread just parent_event_id for provenance.
      const preLlmMeta = { parent_event_id: signalCreatedEventId ?? payload.parent_event_id };
      try {
        const linked = await maybeLinkContactsForEntity(supabase, actor, ent.data.id, channel_id, preLlmMeta, policy.enrichment?.hunter_monthly_cap);
        if (linked > 0) {
          await callTool(supabase, actor, 'post_to_channel', {
            channel_id, kind: 'system', body: `Linked ${linked} contact${linked === 1 ? '' : 's'} via Hunter.io.`,
          }, preLlmMeta);
        }
      } catch {
        // Non-fatal — drafter can still produce a draft without contacts; the
        // gate just won't autofill the To: address.
      }
    }
    try {
      const outs = await pastOutcomesFn(supabase, payload.workspace_id, {
        entity_id: ent.data.id, semantic_neighbors: true, limit: 5, since_days: 30,
      });
      pastOutcomesList = outs.map((o) => ({
        entity_name: o.entity_name, gate_policy: o.gate_policy, decision: o.decision,
        decided_at: o.decided_at, similarity: o.similarity, resolution: o.resolution ?? {},
      }));
    } catch { /* non-fatal */ }

    // Contacts: read facts where works_at = entity_id, then their email + role facts
    try {
      const contactRows = await supabase.from('facts').select('subject_entity')
        .eq('workspace_id', payload.workspace_id)
        .eq('predicate', 'works_at').eq('object_entity', ent.data.id)
        .is('supersedes', null).limit(5);
      const contactIds = ((contactRows.data ?? []) as Array<{ subject_entity: string }>).map((r) => r.subject_entity);
      if (contactIds.length) {
        const [emailFacts, roleFacts, contactEnts] = await Promise.all([
          supabase.from('facts').select('subject_entity, object_text')
            .eq('workspace_id', payload.workspace_id).in('subject_entity', contactIds)
            .eq('predicate', 'email').is('supersedes', null),
          supabase.from('facts').select('subject_entity, object_text')
            .eq('workspace_id', payload.workspace_id).in('subject_entity', contactIds)
            .eq('predicate', 'role').is('supersedes', null),
          supabase.from('entities').select('id, name').in('id', contactIds),
        ]);
        const emailById = new Map<string, string>();
        const roleById = new Map<string, string>();
        const nameById = new Map<string, string>();
        for (const r of (emailFacts.data ?? []) as Array<{ subject_entity: string; object_text: string }>) emailById.set(r.subject_entity, r.object_text);
        for (const r of (roleFacts.data ?? []) as Array<{ subject_entity: string; object_text: string }>) roleById.set(r.subject_entity, r.object_text);
        for (const r of (contactEnts.data ?? []) as Array<{ id: string; name: string }>) nameById.set(r.id, r.name);
        contacts = contactIds
          .filter((id) => emailById.has(id))
          .map((id) => ({ name: nameById.get(id) ?? '(unknown)', email: emailById.get(id)!, role: roleById.get(id) ?? '' }))
          .slice(0, 3);
      }
    } catch { /* non-fatal */ }
  }

  // Relationship-edge extraction config (Step 2). Off by default; when on, the
  // enricher tags entity-objects so the dispatch can resolve them into edges.
  const enr = (policy.enrichment ?? {}) as { resolve_entities?: boolean; node_types?: string[] };
  const resolveEntities = !!enr.resolve_entities;
  const nodeTypes = Array.isArray(enr.node_types) ? enr.node_types : ['account', 'contact', 'product'];
  let edgeVocab: string[] = [];
  if (behavior === 'enricher' && resolveEntities) {
    const ev = await supabase.from('facts').select('predicate')
      .eq('workspace_id', payload.workspace_id).not('object_entity', 'is', null).limit(1000);
    const counts: Record<string, number> = {};
    for (const row of (ev.data ?? []) as Array<{ predicate: string }>) counts[row.predicate] = (counts[row.predicate] ?? 0) + 1;
    edgeVocab = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([p]) => p);
  }

  const systemPrompt = buildSystemPrompt(behavior, about, constitution, ws.data.persona, ws.data.icp, {
    examples: (policy.enrichment?.example_facts ?? []) as Array<{ predicate: string; object_text: string }>,
    banned: (policy.enrichment?.banned_predicates ?? []) as string[],
    resolveEntities,
    edgeVocab,
    nodeTypes,
  }, {
    outreach_channel: policy.drafter?.outreach_channel,
    subject_style: policy.drafter?.subject_style,
    paragraph_count: policy.drafter?.paragraph_count,
    pain_points: policy.drafter?.pain_points,
    value_props: policy.drafter?.value_props,
    tone_keywords: policy.drafter?.tone_keywords,
    ask_examples: policy.drafter?.ask_examples,
    // forbidden_phrases in the PROMPT (post-LLM sanitize is separate, via banned_phrases).
    forbidden_phrases: policy.outreach?.banned_phrases ?? [],
    forbidden_field_terms: policy.drafter?.forbidden_field_terms ?? [],
    market_brief: policy.drafter?.market_brief,
  });
  // Compute the deterministic shortlist for drafters. ~30 token addition; the
  // drafter prompt is told to prefer these but can override when context demands.
  // Skipped for non-drafter behaviors (claim_poster/enricher don't pick angles).
  let recommended: FactScore[] = [];
  if (behavior === 'drafter') {
    try {
      recommended = await scoreFacts(supabase, {
        workspace_id: payload.workspace_id,
        account_entity_id: ent.data.id,
        facts: activeFacts.map((f) => ({
          id: f.id, predicate: f.predicate, object_text: f.object_text,
          confidence: f.confidence, observed_at: f.observed_at, source_event_id: f.source_event_id,
        })),
        config: (policy as Record<string, unknown>).fact_ranking as Record<string, unknown> | undefined,
      });
    } catch { /* non-fatal */ }
  }
  const userPrompt = buildUserPrompt(payload.agent, subName, subSemantic, sigData, ent.data, activeFacts, pastOutcomesList, contacts, recommended, behavior === 'drafter');

  let llm;
  try {
    llm = await chatCompleteForWorkspace(supabase, payload.workspace_id, {
      model,
      behavior,
      // DeepSeek-v4 spends output tokens on reasoning before emitting content;
      // a rich hiring post needs headroom or the JSON body comes back empty.
      max_tokens: behavior === 'drafter' ? 1500 : 1200,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });
  } catch (e) {
    return { ok: false, action: 'skip', reason: e instanceof Error ? e.message : String(e), behavior };
  }
  const promptHash = createHash('sha256').update(systemPrompt + '\n' + userPrompt).digest('hex');

  let decision: any;
  try { decision = JSON.parse(llm.text); } catch {
    return { ok: false, action: 'skip', reason: `LLM returned non-JSON: ${llm.text.slice(0, 200)}`, behavior };
  }

  const validCites = ((decision.cites ?? []) as string[]).filter((c) => activeFacts.some((f) => f.id === c));
  const meta = { prompt_hash: promptHash, parent_event_id: signalCreatedEventId ?? payload.parent_event_id };
  const tokens = {
    llm_input_tokens: llm.input_tokens,
    llm_output_tokens: llm.output_tokens,
    llm_cached_input_tokens: llm.cached_input_tokens,
    llm_provider: llm.provider,
    llm_model: llm.model,
  };

  // Persist run metrics so we can aggregate token usage across workspace + time.
  // No projection needed; just an event row keyed to the workspace.
  try {
    await supabase.from('events').insert({
      workspace_id: payload.workspace_id,
      actor_kind: actor.actor_kind,
      actor_id: actor.actor_id,
      action: 'agent_run_metrics',
      target_kind: 'workspace',
      target_id: payload.workspace_id,
      payload: {
        behavior, agent: payload.agent,
        signal_id: payload.signal_id ?? null,
        entity_id: ent.data.id,
        signal_body_hash: signalBodyHash,
        model: llm.model, provider: llm.provider,
        input_tokens: llm.input_tokens,
        output_tokens: llm.output_tokens,
        cached_input_tokens: llm.cached_input_tokens,
      },
      prompt_hash: promptHash,
      parent_event_id: payload.parent_event_id ?? null,
    });
  } catch {
    // Non-fatal: agent run still succeeded.
  }

  // ============================================================
  // Dispatch
  // ============================================================
  if (decision.action === 'post_claim' && behavior === 'claim_poster') {
    const r = await callTool(supabase, actor, 'post_to_channel', {
      channel_id, kind: 'claim', body: sanitize(decision.body ?? ''), cites: validCites,
    }, meta);
    if (!r.ok) return { ok: false, action: 'skip', reason: r.error, behavior, ...tokens };
    return { ok: true, action: 'post_claim', channel_post_id: r.target_id, behavior, ...tokens };
  }

  if (decision.action === 'post_touch_draft' && behavior === 'drafter') {
    const outreachChannel = policy.drafter?.outreach_channel ?? 'email';
    const subject = sanitize((decision.subject as string) ?? '');
    const body = sanitize((decision.body as string) ?? '');
    const llmTo = ((decision as { to_email?: string | null }).to_email ?? '').toString().trim();
    const toEmail = outreachChannel === 'linkedin' ? '' : (llmTo || (policy.outreach?.override_to ?? '').toString().trim());
    const toLine = toEmail ? `To: ${toEmail}\n` : '';
    // LinkedIn: body only (no To/Subject headers). Email: full composed header block.
    const composed = outreachChannel === 'linkedin'
      ? body
      : (subject ? `${toLine}Subject: ${subject}\n\n${body}` : `${toLine}${body}`);
    const r = await callTool(supabase, actor, 'post_to_channel', {
      channel_id, kind: 'touch_draft', body: composed, cites: validCites,
    }, meta);
    if (!r.ok) return { ok: false, action: 'skip', reason: r.error, behavior, ...tokens };
    // Open an approval for this draft. Sending is irreversible — gates are
    // exactly the right primitive here. The condition jsonb is the full,
    // already-parsed send payload so /api/gates/decide doesn't need to re-parse
    // the post body string at approval time.
    await callTool(supabase, actor, 'request_gate', {
      channel_post_id: r.target_id,
      policy: 'outreach_send',
      condition: {
        channel_type: outreachChannel,
        to_email: toEmail || null,
        subject: outreachChannel === 'linkedin' ? undefined : subject,
        body,
        entity_id: ent.data.id,
        entity_name: ent.data.name,
      },
    }, meta);
    // Lifecycle: a draft + approval request now exist for this account. Record
    // the transition so the outreach stage reads cleanly (researched → drafted).
    // only_advance keeps an already-contacted account from regressing. Non-fatal.
    try {
      await setOutreachStage(supabase, actor, ent.data.id, 'drafted', { signal_id: sigData?.id ?? payload.signal_id });
    } catch { /* non-fatal — a stage-write hiccup must not block the draft */ }
    // Auditable decision post explaining why we drafted. Cites the same facts so the
    // provenance walk works from either the draft or the decision.
    const reasoning = sanitize(((decision as { reasoning?: string }).reasoning ?? '').toString());
    if (reasoning) {
      await callTool(supabase, actor, 'post_to_channel', {
        channel_id, kind: 'decision', body: reasoning, cites: validCites, parent_post_id: r.target_id,
      }, meta);
    }
    // Shortlist instrumentation: every draft records what the formula recommended vs
    // what the model picked. Later joined with outcomes to validate the ranking.
    try {
      const recommendedIds = recommended.map((f) => f.id);
      const recommendedSet = new Set(recommendedIds);
      const citedFromShortlist = validCites.filter((c) => recommendedSet.has(c));
      await supabase.from('events').insert({
        workspace_id: payload.workspace_id,
        actor_kind: actor.actor_kind,
        actor_id: actor.actor_id,
        action: 'drafter_shortlist_pick',
        target_kind: 'channel_post',
        target_id: r.target_id,
        payload: {
          entity_id: ent.data.id,
          channel_post_id: r.target_id,
          recommended_fact_ids: recommendedIds,
          recommended_scores: recommended.map((f) => ({ id: f.id, score: Number(f.score.toFixed(3)), components: f.components })),
          actually_cited: validCites,
          cited_from_shortlist: citedFromShortlist,
          override: recommendedIds.length > 0 && citedFromShortlist.length === 0,
        },
        prompt_hash: promptHash,
        parent_event_id: payload.parent_event_id ?? null,
      });
    } catch { /* non-fatal */ }
    return { ok: true, action: 'post_touch_draft', channel_post_id: r.target_id, behavior, ...tokens };
  }

  if (decision.action === 'request_gate') {
    // Agent decided not to act, but said so in writing. Audit-trail entry, not
    // a human approval — no gate is created. (See CLAUDE.md: gates are for
    // irreversible actions only.)
    const policy = (decision.policy ?? 'low_confidence') as string;
    const r = await noteDecision(supabase, actor, channel_id, payload.parent_event_id,
      `[${policy}] ${sanitize(decision.body ?? '')}`, validCites);
    return { ok: r.ok, action: 'skip', channel_post_id: r.channel_post_id, reason: policy, behavior, ...tokens };
  }

  // Enricher dispatch: assert each extracted fact, then post a one-line summary.
  // assert_fact is content-hashed, so re-asserting an identical fact is idempotent.
  if (behavior === 'enricher') {
    const facts = (decision.facts ?? []) as Array<{ predicate: string; object_text: string; object_type?: string; domain?: string; confidence: number }>;
    let asserted = 0;
    let assertedSubstantive = false;
    const assertedIds: string[] = [];
    for (const f of facts) {
      if (!f.predicate || !f.object_text) continue;
      const conf = typeof f.confidence === 'number' ? Math.max(0, Math.min(1, f.confidence)) : 0.7;
      const predicate = f.predicate.toLowerCase().replace(/\s+/g, '_');

      // Edge path: when enabled and the LLM tagged the object as a modeled entity
      // kind, resolve it to a real entity and write object_entity instead of text.
      // No-match degrades to object_text so the claim is never lost.
      let edgeTargetId: string | null = null;
      if (resolveEntities && f.object_type && nodeTypes.includes(f.object_type) && looksLikeEntityName(f.object_text)) {
        try {
          const res = await resolveOrCreateEntity(supabase, actor, {
            name: f.object_text,
            object_type: f.object_type,
            domain: f.domain ?? null,
            subject_entity: ent.data.id,
            signal_id: sigData?.id ?? null,
          });
          edgeTargetId = res.entity_id;
        } catch { /* fall through to text */ }
      }

      const r = await callTool(supabase, actor, 'assert_fact', {
        subject_entity: ent.data.id,
        predicate,
        ...(edgeTargetId ? { object_entity: edgeTargetId } : { object_text: f.object_text }),
        confidence: conf,
        // Bind fact to the signal that triggered this enricher run. The cite
        // chain walker uses this directly; falls back to the parent-event walk
        // only for legacy facts where signal_id is null.
        ...(sigData?.id ? { signal_id: sigData.id } : {}),
      }, meta);
      // Count + cite only facts this run actually created. A content-hash dedup
      // hit returns ok:true with created:false (the fact was already known); the
      // old `if (r.ok)` counted those as new, so re-asserting known facts inflated
      // `asserted` → a spurious "Extracted N facts" claim post + a needless rescore.
      if (r.ok && r.created) { asserted++; assertedIds.push(r.target_id); if (isSubstantiveFact(predicate)) assertedSubstantive = true; }
      // Per-fact failures don't bubble — the run is still useful with N-1 facts.
    }
    // Only post when we extracted something. Zero-fact runs become audit-trail
    // events instead of channel noise. The summary still lives in the LLM's
    // output if needed for debugging — it's just not surfaced as a "claim."
    let post: { ok: boolean; target_id?: string; error?: string } = { ok: false };
    if (asserted > 0) {
      // Auto-score: only re-run when the enricher actually asserted new facts.
      // Score is a pure function of facts; identical facts in = identical score
      // out, so skipping when nothing changed saves the LLM + 4 embedding calls
      // per scoreEntity invocation. scoreEntity has its own guard as
      // defense-in-depth. Rescored BEFORE the claim post (not after) so the
      // marginal delta (score_after - score_before) can be attached to the
      // exact claim that caused it — score is a pure function of facts, and
      // these are the only new facts since priorScore was read.
      let score: Awaited<ReturnType<typeof scoreAndAssertFn>> = null;
      let priorScore = NaN;
      let scoreDelta: number | null = null;
      // Promote a candidate on its first substantive fact. resolveOrCreateEntity
      // creates new accounts as `_candidate: true` thin nodes, and scoreEntity
      // refuses to score candidates (scoring.ts `_candidate` guard) "until
      // promoted" — but the promotion step was never built, so candidates piled up
      // facts the scorer ignored forever (the score_signal_coupling RED). Clearing
      // the flag here, before scoreAndAssert below, lets the score finally run.
      if (assertedSubstantive && (ent.data.attributes as { _candidate?: boolean } | null)?._candidate === true) {
        try {
          await supabase.from('entities')
            .update({ attributes: { ...(ent.data.attributes as Record<string, unknown>), _candidate: false } })
            .eq('id', ent.data.id);
        } catch { /* non-fatal: scoreAndAssert no-ops this run, next substantive fact retries */ }
      }
      try {
        const priorScoreText = activeFacts.find((f) => f.predicate === 'score_total')?.object_text
          ?? activeFacts.find((f) => f.predicate === 'icp_fit')?.object_text;
        priorScore = priorScoreText ? parseFloat(priorScoreText) : NaN;
        score = await scoreAndAssertFn(supabase, actor, ent.data.id);
        if (score && Number.isFinite(priorScore)) scoreDelta = score.icp_fit - priorScore;
      } catch {
        // Non-fatal: the claim still posts without a score/delta.
      }

      const summary = sanitize((decision.summary as string) ?? `Extracted ${asserted} fact${asserted === 1 ? '' : 's'}.`);
      post = await callTool(supabase, actor, 'post_to_channel', {
        channel_id, kind: 'claim', body: summary, cites: assertedIds,
        ...(scoreDelta !== null ? { score_delta: scoreDelta } : {}),
      }, meta);
      const reasoning = sanitize(((decision as { reasoning?: string }).reasoning ?? '').toString());
      if (reasoning && post.ok) {
        await callTool(supabase, actor, 'post_to_channel', {
          channel_id, kind: 'decision', body: reasoning, cites: assertedIds, parent_post_id: post.target_id,
        }, meta);
      }

      // Post the score reasoning only on band change — the band maps to
      // downstream action_selector thresholds, so a band shift is what
      // actually changes behavior. Reuses the score computed above; no
      // second rescore call.
      if (score && (!Number.isFinite(priorScore) || icpBand(priorScore) !== icpBand(score.icp_fit))) {
        const bandReasoning = `ICP fit ${score.icp_fit.toFixed(2)} (${icpBand(score.icp_fit)}) — ${score.reasoning}`;
        await callTool(supabase, actor, 'post_to_channel', {
          channel_id, kind: 'decision', body: bandReasoning, cites: assertedIds,
        }, meta);
      }
    } else {
      await supabase.from('events').insert({
        workspace_id: payload.workspace_id,
        actor_kind: 'agent',
        actor_id: payload.agent,
        action: 'enrichment_no_facts',
        target_kind: 'entity',
        target_id: ent.data.id,
        payload: {
          signal_id: payload.signal_id ?? null,
          summary: sanitize((decision.summary as string) ?? 'No new facts extracted'),
        },
        parent_event_id: payload.parent_event_id ?? null,
      });
    }
    // Contact lookups moved from here to the drafter pre-flight — see the
    // `behavior === 'drafter'` block above. The enricher fires on every signal,
    // which used to burn Hunter credits on hundreds of entities we'd never
    // actually message. Drafter-time lookup ties spend to outbound volume.
    // Lifecycle: facts were extracted for this account → it has been researched.
    // Gate on asserted > 0 so an empty enrichment run doesn't claim progress.
    // only_advance keeps a later re-run from regressing a drafted/contacted account.
    if (asserted > 0) {
      try {
        await setOutreachStage(supabase, actor, ent.data.id, 'researched', { signal_id: sigData?.id ?? payload.signal_id });
      } catch { /* non-fatal — enrichment already landed */ }
    }
    // Separate from agent_run_metrics (which captures LLM cost at LLM-call time):
    // this event captures the dispatch outcome and is what source_metrics reads
    // to compute fact_yield per source. Keyed by signal_id so the join to
    // signals.structured_tags.source_id is one hop.
    try {
      await supabase.from('events').insert({
        workspace_id: payload.workspace_id,
        actor_kind: actor.actor_kind,
        actor_id: actor.actor_id,
        action: 'agent_dispatch_result',
        target_kind: 'entity',
        target_id: ent.data.id,
        payload: {
          behavior, agent: payload.agent,
          signal_id: payload.signal_id ?? null,
          subscription_id: payload.subscription_id ?? null,
          ok: true,
          dispatch_action: 'enrich',
          facts_asserted: asserted,
        },
        parent_event_id: payload.parent_event_id ?? null,
      });
    } catch {
      // Non-fatal — the enrichment itself already landed.
    }
    return {
      ok: true, action: 'enrich',
      channel_post_id: post.ok ? post.target_id : undefined,
      facts_asserted: asserted,
      behavior,
      ...tokens,
    };
  }

  return { ok: false, action: 'skip', reason: `unexpected action "${decision.action}" for behavior "${behavior}"`, behavior, ...tokens };
}

// ----------------------------------------------------------------
// prompts (system message stable per workspace+behavior; cacheable)
// ----------------------------------------------------------------

// Stable preamble shared by every behavior in this workspace. Lives at the top
// of the system message so OpenAI's prompt cache (1024-token minimum, ~5-10 min
// TTL) covers it across runs. The enricher path was previously coming in at
// 1009 tokens — 15 short of the threshold — which is why the 24-h cache rate
// was 0%. This block is genuine grounding context, not filler: it tells the
// LLM how the broader system works so cite/skip/gate decisions land correctly.
const SYSTEM_PREAMBLE = `You operate inside an agent-native CRM. Here is how the surrounding system works, so your output lands in the right place:

DATA MODEL — accounts and contacts are "entities." Each entity has attributes (a small jsonb you can read but not directly modify) and any number of FACTS asserted against it. A fact is one atomic, citable claim: subject_entity + predicate + object_text + confidence + source_event_id. Facts are content-addressed — re-asserting an identical fact is a no-op. Facts that get refined later use a supersede chain; only non-superseded facts are "active."

EVENTS — every action your peers and you take is appended to an event log. The event log is the source of truth, not the projection tables. This is why provenance and replay work — a downstream agent can reconstruct what any other agent saw at the moment it decided. When you cite a fact_id, the audit trail can walk back from your post to the exact signal that produced the fact.

SUBSCRIPTIONS — you are running because a saved filter (the FILTER RULE in the user message) matched an incoming signal. The filter is a PRIORITIZATION SIGNAL, not a hard constraint. If the signal would benefit a different downstream consumer's filter rule, that's that agent's job — not yours.

CITATION DISCIPLINE — every claim you make should be backed by a fact_id from the ACTIVE FACTS list in the user message. If you cite a fact_id that isn't in the list, it gets stripped silently. If you cannot cite anything, gate or skip — do not make unsupported claims.

DUPLICATION — the system already runs deterministic checks before invoking you. If you see a familiar account, assume any obvious fact is already known. Re-asserting known facts is noise; the downstream sees it as low-signal output.

Now to your specific task.`;

function buildSystemPrompt(
  behavior: AgentBehavior,
  about: string,
  constitution: string,
  persona: unknown,
  icp: unknown,
  enricherPolicy?: { examples?: Array<{ predicate: string; object_text: string }>; banned?: string[]; resolveEntities?: boolean; edgeVocab?: string[]; nodeTypes?: string[] },
  drafterPolicy?: {
    outreach_channel?: 'email' | 'linkedin';
    subject_style?: 'one_word' | 'short_phrase' | 'question';
    paragraph_count?: number;
    pain_points?: string[];
    value_props?: string[];
    tone_keywords?: string[];
    ask_examples?: string[];
    forbidden_phrases?: string[];
    forbidden_field_terms?: string[];
    market_brief?: { enabled?: boolean; items?: Array<{ text: string; url?: string; date?: string }> };
  },
): string {
  const identity = behavior === 'drafter'
    ? (drafterPolicy?.outreach_channel === 'linkedin'
      ? 'You are an outbound LinkedIn message drafter for an agent-native CRM.'
      : 'You are an outbound-email drafter for an agent-native CRM.')
    : behavior === 'enricher'
    ? 'You are a fact extractor for an agent-native CRM. You read incoming signals and turn them into atomic, citable claims about entities.'
    : 'You are an autonomous CRM agent.';

  const aboutBlock = about
    ? `\n\nABOUT THIS COMPANY (what we sell, who we sell to, how we're different):\n${about}`
    : `\n\nWorkspace persona: ${JSON.stringify(persona)}.\nWorkspace ICP: ${JSON.stringify(icp)}.`;

  const constitutionBlock = constitution
    ? `\n\nWORKSPACE CONSTITUTION (applies to every action — voice, do-nots, brand rules):\n${constitution}`
    : '';

  const enricherDecision = buildEnricherDecision({
    examples: enricherPolicy?.examples ?? [],
    banned: enricherPolicy?.banned ?? [],
    resolveEntities: enricherPolicy?.resolveEntities,
    edgeVocab: enricherPolicy?.edgeVocab,
    nodeTypes: enricherPolicy?.nodeTypes,
  });
  const drafterDecision = buildDrafterDecision({
    subject_style: drafterPolicy?.subject_style,
    paragraph_count: drafterPolicy?.paragraph_count,
    pain_points: drafterPolicy?.pain_points,
    value_props: drafterPolicy?.value_props,
    tone_keywords: drafterPolicy?.tone_keywords,
    ask_examples: drafterPolicy?.ask_examples,
    forbidden_phrases: drafterPolicy?.forbidden_phrases,
    forbidden_field_terms: drafterPolicy?.forbidden_field_terms,
    market_brief: drafterPolicy?.market_brief,
  });

  const decisionBlock = behavior === 'drafter' ? drafterDecision
    : behavior === 'enricher' ? enricherDecision
    : POSTER_DECISION;

  // Order matters: preamble (stable, cacheable) → identity (stable) → about
  // (stable per workspace) → constitution (stable per workspace) → decision
  // (stable per behavior). The longest stable prefix across runs is everything
  // up to the decision block, which is what OpenAI's cache keys off.
  return `${SYSTEM_PREAMBLE}\n\n${identity}${aboutBlock}${constitutionBlock}\n\n${decisionBlock}`;
}

const POSTER_DECISION = `A new signal matched your saved filter rule. Decide ONE action:

POST_CLAIM — when the signal clearly aligns with the filter's intent AND you can cite at least one supporting fact_id from the active facts list provided in the user message.
REQUEST_GATE — when confidence is below 0.6, OR the body would assert something not backed by an active fact, OR the signal contradicts a fact.

Output strictly valid JSON, no preamble:
{"action":"post_claim"|"request_gate","body":"<1-2 sentences>","cites":["<fact_id_uuid>",...],"policy":"<for gate only>","condition":{<for gate only>}}`;

/**
 * Vertical-neutral default examples. Used when the workspace hasn't seeded
 * its own. They're broad enough to be a starting nudge without forcing a
 * B2B-SaaS taxonomy onto a non-SaaS use case.
 */
const DEFAULT_ENRICHER_EXAMPLES: Array<{ predicate: string; object_text: string }> = [
  { predicate: 'target_market',  object_text: '<who this entity sells to / serves>' },
  { predicate: 'recent_event',   object_text: '<launched / hired / raised / changed / etc.>' },
];

/**
 * Always-banned predicates (low-info, never useful). Stacks with
 * policy.enrichment.banned_predicates on top.
 */
const DEFAULT_BANNED_PREDICATES = new Set(['is_company', 'is_real', 'exists', 'is_in_tech', 'is_business']);

function buildEnricherDecision(opts: {
  examples: Array<{ predicate: string; object_text: string }>;
  banned: string[];
  resolveEntities?: boolean;
  edgeVocab?: string[];
  nodeTypes?: string[];
}): string {
  const examples = (opts.examples.length ? opts.examples : DEFAULT_ENRICHER_EXAMPLES)
    .slice(0, 8)
    .map((f) => `- ${f.predicate}=${f.object_text}`)
    .join('\n');
  const bannedAll = [...new Set([...DEFAULT_BANNED_PREDICATES, ...opts.banned])];
  const bannedLine = bannedAll.length
    ? `\n- Never assert these predicates: ${bannedAll.join(', ')}.`
    : '';

  // Relationship-edge instructions. Empty unless the workspace enables it, so the
  // default prompt stays byte-for-byte unchanged for every existing workspace.
  const nodeTypeList = opts.nodeTypes ?? ['account', 'contact', 'product'];
  const vocabLine = opts.edgeVocab && opts.edgeVocab.length
    ? `Reuse an existing relationship type when one fits: ${opts.edgeVocab.join(', ')}. Coin a new lowercase predicate only when none fits.`
    : `Name the relationship with a clear lowercase predicate (e.g. customer_of, backed_by, partners_with, integrates_with).`;
  const relBlock = opts.resolveEntities
    ? `\n\nRELATIONSHIPS — when object_text names ANOTHER organization, person, or product THIS entity is related to (a customer, investor, partner, competitor, acquirer, employer, etc.), set "object_type" to its kind (${nodeTypeList.join(' / ')}) and, if you know it, set "domain" to its website (e.g. "stripe.com"). ${vocabLine} For any value that is NOT a named entity (a stage, count, description, pain, or a stack item like a programming language), set "object_type" to "literal" and omit domain.`
    : '';
  const objSchema = opts.resolveEntities
    ? `{"predicate":"<verb_or_attribute>","object_text":"<value or entity name>","object_type":"<${nodeTypeList.join('|')}|literal>","domain":"<website if object_type is an org; else omit>","confidence":0.0-1.0}`
    : `{"predicate":"<verb_or_attribute>","object_text":"<value>","confidence":0.0-1.0}`;

  return `A new signal arrived about the account in the user message. Extract atomic factual claims about THIS entity that are supported by the signal AND that the system doesn't already know.

IDENTITY CHECK (do this first) — companies and people can share a name. Cross-check the signal's content and source URL (in SIGNAL.structured_tags) against this account's own ATTRIBUTES (domain, website, industry, description) in the user message. If the signal clearly describes a different organization that merely shares this name — different domain, different industry, different product — treat it as nothing extractable: output {"facts":[],"summary":"skipped: signal describes a different entity with the same name","reasoning":"<what mismatched>"}.

DO NOT extract:
- Anything already present in the entity's ATTRIBUTES (the JSON object in the user message). The values there are authoritative; re-asserting them as facts is noise.
- Anything already present in the ACTIVE FACTS list. Those exist; don't duplicate.
- Generic descriptors that are obvious from the entity name or category.${bannedLine}

DO extract specific claims grounded in the signal. The kinds of facts that matter for THIS workspace look like:
${examples}

(These are the workspace's example shapes — extract anything that fits the same level of specificity, not literally these only.)

Each claim should be:
- ATOMIC: one predicate, one object. Not "uses postgres and redis."
- VERBATIM-GROUNDED: only what's stated or directly implied. No speculation.

Use object_text for the value. Confidence: 0.95 explicit, 0.7 implied. Skip lower.${relBlock}

PAIN EXTRACTION (second pass) — separately from the demographic facts above, extract any pain, frustration, complaint, unmet need, manual-toil pattern, or expressed limitation the source describes. Use predicate "pain_observed" and an object_text that captures the pain in concrete terms, preferring the source's own wording where possible. Each pain_observed entry goes in the SAME facts[] array as the demographic facts above and MUST include the confidence field (0.95 directly stated, 0.7 strongly implied) — same JSON schema, no separate section. Examples (these are SHAPES, not a closed list — extract anything that fits regardless of vertical):
- pain_observed = "founder writing every outbound email personally, no time to scale"
- pain_observed = "current tooling forces context switches between 4 apps daily"
- pain_observed = "took 3 weeks to ship last marketing email due to legal review"
- pain_observed = "considered hiring SDR but couldn't justify the cost at current revenue"

Pain is usually expressed indirectly. Look for: complaints ("we hate / can't / wish"), descriptions of manual work ("we still do X by hand"), references to gaps ("we don't have X yet"), or descriptions of friction ("X takes us Y hours / weeks"). Statements about challenges, constraints, manual workarounds, or what doesn't work today ARE pain — extract them as pain_observed even when stated calmly and factually, not just when emotionally vented. Do not split the same pain across pain_observed and another predicate like has_challenge or seeks_solution; use pain_observed for the pain itself. Skip if the source is purely positive / promotional / announcement-only with no friction language. Confidence 0.95 if directly stated, 0.7 if strongly implied. Do not invent pains that aren't on the page.

DEPTH (when the signal carries a rich payload — a long post, a detailed listing, a press release — go deep, but stay on the SUBJECT company). Extract details that describe THIS company: what it builds, sells, or offers; who it serves; its stage, size, stack, funding, customers, partners; a notable thing it's doing (launched / hired / raised / shipped); and any pain — plus one short summary fact of the event itself. Do NOT extract details that only describe the internals of the artifact rather than the company. Concretely: a job posting's required skills, years of experience, nice-to-haves, and ideal-candidate traits describe a hypothetical hire, not the company — from a job posting, capture that the company is hiring for role X (and any pain the posting implies about why), NOT the checklist of what they want in a candidate. The test for each fact: is it a claim about the company, or about the contents/spec of this one artifact? Keep the first, drop the second. Reuse a predicate the workspace examples or the entity's ACTIVE FACTS already use; coin a new lowercase predicate only when none fits, and never split one idea across near-synonym predicates (e.g. requirement / requires / required_attribute). One predicate, one object — never collapse multiple details into a single fact. If the payload is empty or generic, extract only what's actually there and skip the rest. Confidence 0.95 when explicit, 0.7 when strongly implied.

REASONING — include a "reasoning" field explaining why you picked these facts (or why you skipped). 1-2 sentences. This becomes a separate "decision" post so the audit trail explains the extraction.

Output strictly valid JSON:
{"facts":[${objSchema},...],"summary":"<1 sentence>","reasoning":"<why these facts, 1-2 sentences>"}

If nothing genuinely new is extractable, output {"facts":[],"summary":"No new facts; data already known or signal too vague.","reasoning":"<why nothing new>"}`;
}

function buildUserPrompt(
  agentId: string,
  subName: string,
  subSemantic: string,
  signal: any,
  entity: { id: string; name: string; attributes: unknown },
  activeFacts: Array<{ id: string; predicate: string; object_text: string | null; confidence: number }>,
  pastOutcomesList: Array<{ entity_name: string; gate_policy: string; decision: string; decided_at: string; similarity: number | null; resolution: Record<string, unknown> }> = [],
  contacts: Array<{ name: string; email: string; role: string }> = [],
  recommended: FactScore[] = [],
  // Drafters get attributes as readable prose so the email never echoes internal
  // field names ("domain", "stack"). The enricher keeps raw JSON keys — it needs
  // them to know what's already extracted and avoid re-asserting.
  proseAttributes = false,
): string {
  // Strip embedding from signal (massive vector adds nothing for the LLM and burns tokens).
  const { embedding: _e, ...signalForPrompt } = signal ?? {};

  const pastOutcomesBlock = pastOutcomesList.length
    ? `\nPAST OUTCOMES (recent gate decisions on this entity or semantically similar ones — pay attention to repeated patterns):\n${pastOutcomesList.map((o) => {
        const sim = o.similarity != null ? ` sim=${o.similarity.toFixed(2)}` : '';
        const res = o.resolution ?? {};
        const parts: string[] = [];
        if (typeof res.note === 'string' && res.note) parts.push(`note: "${res.note}"`);
        if (res.edited) {
          const sd = res.subject_diff as { from: string; to: string } | undefined;
          const bd = res.body_diff as Array<{ from: string; to: string }> | undefined;
          if (sd) parts.push(`subject: "${sd.from}" → "${sd.to}"`);
          if (bd?.length) parts.push(`body: ${bd.map((d) => `"${d.from}" → "${d.to}"`).join('; ')}`);
        }
        const detail = parts.length ? ` — ${parts.join('; ')}` : '';
        return `  ${o.decided_at.slice(0, 10)} ${o.entity_name}${sim}: ${o.decision} (policy=${o.gate_policy})${detail}`;
      }).join('\n')}\n`
    : '';

  const contactsBlock = contacts.length
    ? `\nCONTACTS (linked to this account — pick the best fit for the role you're targeting):\n${contacts.map((c) => `  ${c.name} <${c.email}>${c.role ? ` — ${c.role}` : ''}`).join('\n')}\n`
    : '';

  const recommendedBlock = recommended.length
    ? `\nRECOMMENDED FACTS (deterministic shortlist — prefer one of these as your lead unless the past_touch context demands otherwise):\n${recommended.map((r) => `  ${r.id} (score=${r.score.toFixed(2)}): ${r.why}`).join('\n')}\n`
    : '';

  return `AGENT: ${agentId}
FILTER RULE: "${subName}" — semantic intent: "${subSemantic}"

SIGNAL:
${JSON.stringify(signalForPrompt, null, 2)}

ACCOUNT: ${entity.name}
ATTRIBUTES (already known — do not re-extract these as facts):
${proseAttributes ? renderAttributesProse(entity.attributes) : JSON.stringify(entity.attributes, null, 2)}

ACTIVE FACTS (already asserted — do not duplicate):
${activeFacts.length ? activeFacts.map((f) => `  ${f.id} | ${f.predicate}=${f.object_text} (conf=${f.confidence})`).join('\n') : '  (none yet)'}
When a new fact is the same kind of thing as one above, REUSE that fact's label (the part before "=") rather than inventing a new label for it. Only coin a new label when the fact is a genuinely new kind. (e.g. if a label already captures this fact, restate or refine it under that label instead of adding a near-synonym label for the same thing.)
${pastOutcomesBlock}${contactsBlock}${recommendedBlock}
Decide.`;
}

// ----------------------------------------------------------------
// helpers
// ----------------------------------------------------------------

/** Banned phrases the LLM consistently slips in even with "no jargon" rules in the
 *  constitution. Each entry is (regex_to_detect, replacement). Replacement = '' means
 *  excise the whole sentence containing it; '<word>' means swap inline.
 *
 *  This is the deterministic last line of defense. Cheaper than re-prompting. */
const BANNED_PHRASES: Array<{ re: RegExp; replace: string }> = [
  { re: /\blet'?s level up\b/gi, replace: '' },
  { re: /\bin today's fast-paced\b/gi, replace: '' },
  { re: /\bin today's competitive landscape\b/gi, replace: '' },
  { re: /\bexciting space\b/gi, replace: 'space' },
  { re: /\bgame[- ]chang(er|ing)\b/gi, replace: 'meaningful' },
  { re: /\binnovative approach\b/gi, replace: 'approach' },
  { re: /\bcutting[- ]edge\b/gi, replace: '' },
  { re: /\bstreamlin(e|ing|es)\b/gi, replace: 'simplifies' },
  { re: /\bleverag(e|ing|es)\b/gi, replace: 'use' },
  { re: /\bsynerg(y|ies)\b/gi, replace: '' },
  { re: /\brobust\b/gi, replace: 'real' },
  { re: /\bseamless(ly)?\b/gi, replace: '' },
  { re: /\benhance\b/gi, replace: 'improve' },
  { re: /\bunlock the (full )?potential\b/gi, replace: '' },
  { re: /\boptimize (your|the) (operations|workflows?|processes?)\b/gi, replace: '' },
  { re: /\bdrive (real )?(business )?impact\b/gi, replace: '' },
  { re: /\bbest in class\b/gi, replace: '' },
  { re: /\bworld[- ]class\b/gi, replace: '' },
  { re: /\bnext[- ]gen(eration)?\b/gi, replace: '' },
  { re: /\b(quickly|easily|effortlessly)\b/gi, replace: '' },
  // Generic marketing slop — vertical-neutral, so it stays as a code default.
  // Product- or vertical-SPECIFIC pitch phrases (e.g. a workspace selling an
  // "AI-native CRM" / "agent-native platform") do NOT belong here — those are
  // that customer's own words and live in policy.outreach.banned_phrases, which
  // stacks on top via the extraBanned arg below. Keep this list portable.
  { re: /\bpurpose[- ]built (for|to)\b/gi, replace: '' },
  { re: /\bredefin(e|ing) the way\b/gi, replace: '' },
  { re: /\breimagin(e|ing)\b/gi, replace: '' },
];

/** Strip em/en dashes, tidy spacing, and excise corporate-template phrases the
 *  constitution forbids. Sanitize is the last gate before output. The optional
 *  second arg stacks per-workspace banned phrases on top of the code defaults
 *  (case-insensitive substring excise — phrases come from workspace policy, so
 *  we don't trust them to be regex). */
function sanitizeText(s: string, extraBanned: string[] = []): string {
  let out = s
    // Strip leaked template tokens — ${x}, {{x}}, <x> merge fields. A human-written
    // email never contains these; they're model slips echoing internal/source data.
    .replace(/\$\{[^}]*\}/g, '')
    .replace(/\{\{[^}]*\}\}/g, '')
    .replace(/<[^>\n]{1,40}>/g, '')
    .replace(/\s*—\s*/g, ', ')
    .replace(/\s*–\s*/g, ', ');
  for (const { re, replace } of BANNED_PHRASES) {
    out = out.replace(re, replace);
  }
  for (const phrase of extraBanned) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'gi'), '');
  }
  return out
    .replace(/\s{2,}/g, ' ')                                // collapse double spaces from removals
    .replace(/(?<=[a-zA-Z])\s+,\s+/g, ', ')
    .replace(/\s+([.,;:!?])/g, '$1')                        // tidy punctuation after removals
    .replace(/\.\s*\./g, '.')                               // duplicate periods
    .replace(/\(\s*\)/g, '')                                // empty parens
    .replace(/^\s+|\s+$/gm, (m) => m.trim() ? m : '')       // tidy line ends
    .trim();
}

/**
 * ICP-score band. Maps the continuous icp_fit into the four buckets that
 * action_selector cares about: drop (<0.35), watch (0.35–0.5), research
 * (0.5–0.65), draft-ready (≥0.65). A band shift is what changes downstream
 * behavior, so we only post score reasoning when the band actually moves.
 */
function icpBand(score: number): 'drop' | 'watch' | 'research' | 'draft-ready' {
  if (!Number.isFinite(score) || score < 0.35) return 'drop';
  if (score < 0.5) return 'watch';
  if (score < 0.65) return 'research';
  return 'draft-ready';
}

/**
 * Post a `decision` channel post without creating a gate. Used for operational
 * rejections by the agent itself (off_icp, thin_facts, draft_already_exists,
 * etc.). Per CLAUDE.md, gates are reserved for irreversible actions a human
 * must approve — agent-internal skips are audit-trail entries, not human work.
 */
async function noteDecision(
  supabase: SupabaseClient,
  actor: { workspace_id: string; actor_kind: 'agent' | 'user' | 'system'; actor_id: string },
  channel_id: string,
  parent_event_id: string | undefined,
  body: string,
  cites: string[],
): Promise<{ ok: boolean; channel_post_id?: string; error?: string }> {
  const post = await callTool(supabase, actor, 'post_to_channel', {
    channel_id, kind: 'decision', body, cites,
  }, { parent_event_id });
  if (!post.ok) return { ok: false, error: post.error };
  return { ok: true, channel_post_id: post.target_id };
}

/**
 * If the entity has a domain (in attributes or as a fact) AND no contact
 * entities link to it via works_at, fetch top contacts from Hunter and create
 * contact entities. Idempotent on email. Returns count linked.
 *
 * Caps at 3 contacts per entity to avoid burning Hunter quota. The drafter
 * picks the best one based on role.
 */
const HUNTER_NEGATIVE_CACHE_DAYS = 30;

async function maybeLinkContactsForEntity(
  supabase: SupabaseClient,
  actor: { workspace_id: string; actor_kind: 'agent' | 'user' | 'system'; actor_id: string },
  entity_id: string,
  channel_id: string,
  _meta: { prompt_hash?: string; parent_event_id?: string } | undefined,
  hunterMonthlyCap?: number,
): Promise<number> {
  // 1. Already has contacts? Look for any fact predicate=works_at object_entity=entity_id.
  const existing = await supabase.from('facts')
    .select('id')
    .eq('workspace_id', actor.workspace_id)
    .eq('predicate', 'works_at')
    .eq('object_entity', entity_id)
    .is('supersedes', null)
    .limit(1);
  if ((existing.data ?? []).length > 0) return 0;

  // 2. Monthly cap. Count `contact_lookup_attempted` asserted this calendar
  // month and short-circuit if we've already hit the workspace's cap. Done
  // before the negative-cache check so cap-block costs one extra query but
  // never an outbound API call.
  if (hunterMonthlyCap && hunterMonthlyCap > 0) {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const usage = await supabase.from('facts')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', actor.workspace_id)
      .eq('predicate', 'contact_lookup_attempted')
      .gte('observed_at', monthStart);
    const used = usage.count ?? 0;
    if (used >= hunterMonthlyCap) {
      await callTool(supabase, actor, 'post_to_channel', {
        channel_id, kind: 'system',
        body: `Hunter cap hit (${used}/${hunterMonthlyCap} this month). Skipping contact lookup for this entity. Raise policy.enrichment.hunter_monthly_cap or wait for the calendar month to roll over.`,
      });
      return 0;
    }
  }

  // 3. Negative-result cache. If a prior Hunter call on this entity returned
  // zero contacts (or hard-errored), we wrote a `contact_lookup_attempted`
  // fact with a timestamp. Re-calling Hunter is pure waste: same domain →
  // same empty response. Skip for HUNTER_NEGATIVE_CACHE_DAYS.
  const sinceCache = new Date(Date.now() - HUNTER_NEGATIVE_CACHE_DAYS * 86400 * 1000).toISOString();
  const cached = await supabase.from('facts')
    .select('id, observed_at')
    .eq('workspace_id', actor.workspace_id)
    .eq('subject_entity', entity_id)
    .eq('predicate', 'contact_lookup_attempted')
    .is('supersedes', null)
    .gte('observed_at', sinceCache)
    .limit(1);
  if ((cached.data ?? []).length > 0) return 0;

  // 3. Find domain. Prefer attributes.domain, fall back to a fact predicate=domain.
  const ent = await supabase.from('entities').select('attributes')
    .eq('id', entity_id).maybeSingle();
  let domain = ((ent.data?.attributes as { domain?: string } | null)?.domain ?? '').trim().toLowerCase();
  if (!domain) {
    const f = await supabase.from('facts').select('object_text')
      .eq('workspace_id', actor.workspace_id).eq('subject_entity', entity_id)
      .eq('predicate', 'domain').is('supersedes', null).limit(1).maybeSingle();
    domain = ((f.data?.object_text as string) ?? '').trim().toLowerCase();
  }
  if (!domain || domain.endsWith('.example')) return 0;  // skip placeholder domains

  // 4. Hunter lookup
  let contacts;
  try {
    contacts = await findContactsFn({ domain, limit: 3 });
  } catch (e) {
    // Hard error (rate limit, 5xx, etc.). Write the negative marker so we
    // don't immediately retry on every signal. Non-fatal: log + return.
    await callTool(supabase, actor, 'assert_fact', {
      subject_entity: entity_id,
      predicate: 'contact_lookup_attempted',
      object_text: `error:${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`,
      confidence: 1.0,
    });
    await callTool(supabase, actor, 'post_to_channel', {
      channel_id, kind: 'system',
      body: `Contact lookup failed for ${domain}: ${e instanceof Error ? e.message : String(e)}`,
    });
    return 0;
  }
  if (!contacts.length) {
    // Zero-result: write the negative marker. Prevents re-billing Hunter on
    // the same dead domain for HUNTER_NEGATIVE_CACHE_DAYS.
    await callTool(supabase, actor, 'assert_fact', {
      subject_entity: entity_id,
      predicate: 'contact_lookup_attempted',
      object_text: `no_contacts:${domain}`,
      confidence: 1.0,
    });
    return 0;
  }

  // 5. Link top 3
  let linked = 0;
  for (const c of contacts.slice(0, 3)) {
    try {
      const r = await linkContactFn(supabase, actor, {
        account_entity_id: entity_id, name: c.name, email: c.email, role: c.role || undefined,
      });
      if (r.created) linked++;
    } catch {
      // skip; idempotent so retry next cycle is safe
    }
  }
  return linked;
}
