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
import { callTool, pastOutcomes as pastOutcomesFn, findContacts as findContactsFn, linkContactToAccount as linkContactFn, scoreAndAssert as scoreAndAssertFn, selectAction, buildThresholds, loadActionContext, loadBestContactScore, chatCompleteForWorkspace, buildDrafterDecision, renderAttributesProse, scoreFacts, pickDraftAngle, setOutreachStage, resolveOrCreateEntity, looksLikeEntityName, recordActivityMarker, ACTIVITY_MARKERS, resolveQualification, isSubstantiveFact, contactContentFacts, applyContentDate, unreadableContentDate, researchSignalMagnitude, DEFAULT_DECAY_HALF_LIFE_DAYS, resolveBrief, type WorkspacePolicy, type BriefQuestion, type FactScore, type AngleDecision } from '@agent-crm/tools';
// chatComplete is wrapped via chatCompleteForWorkspace from @agent-crm/tools.
import { embed } from '@agent-crm/primitives';
import { createHash } from 'node:crypto';
import { inngest } from '../client.ts';

/** Cosine of two equal-length vectors. Local to keep the fact-dedup guard self-contained. */
function cosineSim(a: number[], b: number[]): number {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na && nb ? d / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

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
    .select('id, predicate, object_text, confidence, supersedes, created_at, observed_at, source_event_id, signal_id')
    .eq('subject_entity', ent.data.id);
  if (allFacts.error) return { ok: false, action: 'skip', reason: `facts query failed: ${allFacts.error.message}` };
  const factRows = (allFacts.data ?? []) as Array<{ id: string; predicate: string; object_text: string | null; confidence: number; supersedes: string | null; created_at: string; observed_at: string; source_event_id: number | null; signal_id: string | null; source_date?: string; recorded_date?: string }>;
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
  // the coalesce window AND actually produced an enricher run, that run already
  // captured the trend — skip the LLM and record the skip as an events row.
  //
  // The "actually produced a run" half is load-bearing: a research pull creates
  // ~10 same-type signals in one minute, most of which never clear a
  // subscription's similarity threshold. The one that DID match used to get
  // skipped here because an unmatched sibling merely EXISTED in the window —
  // 28 research signals, 0 enrichment runs, silently. Skipping is only valid
  // when some prior signal in the window was dispatched to an enricher.
  // Keyed on (entity, signal type), so different signal types and different
  // entities always run.
  // Config: policy.enrichment.coalesce_window_min (default 60, 0 disables).
  const coalesceMin = policy.enrichment?.coalesce_window_min ?? 60;
  // Which signal types this collapsing is allowed to touch. Unset = all types,
  // which is the historical behaviour. See coalesce_signal_types in policy.ts:
  // the "one burst, one trend" logic is right for N job posts and wrong for N
  // distinct articles, and on Sudden 98% of what it dropped was research.
  const coalesceTypes = policy.enrichment?.coalesce_signal_types;
  const typeIsCoalescible = !Array.isArray(coalesceTypes) || coalesceTypes.includes(sigData?.type ?? '');
  if (behavior === 'enricher' && coalesceMin > 0 && typeIsCoalescible && sigData?.type && payload.signal_id && sigData.observed_at) {
    const windowStart = new Date(Date.parse(sigData.observed_at) - coalesceMin * 60_000).toISOString();
    const priors = await supabase.from('signals')
      .select('id')
      .eq('entity_id', ent.data.id)
      .eq('type', sigData.type)
      .neq('id', sigData.id)
      .lt('observed_at', sigData.observed_at)
      .gte('observed_at', windowStart)
      .order('observed_at', { ascending: false })
      .limit(50);
    const priorIds = ((priors.data ?? []) as Array<{ id: string }>).map((p) => p.id);
    let prior: { data: { id: string } | null } = { data: null };
    if (priorIds.length) {
      const ran = await supabase.from('events')
        .select('id, payload')
        .eq('workspace_id', payload.workspace_id)
        .eq('action', 'agent_dispatch_result')
        .in('payload->>signal_id', priorIds)
        .limit(1)
        .maybeSingle();
      if (ran.data) {
        const ranSignal = (ran.data.payload as { signal_id?: string } | null)?.signal_id;
        prior = { data: { id: ranSignal ?? priorIds[0]! } };
      }
    }
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
  // Scoped by the SAME knob as the coalesce window, and it has to be: this
  // cooldown sits directly behind it and asks a broader question ("was this
  // entity enriched at all in the last 20h"), so a type exempted from burst
  // collapsing would just be stopped here instead and the exemption would do
  // nothing. Its rationale is the same ATS one — "prevents a high-volume ATS
  // source from re-enriching the same account on every new job posting" — and
  // it holds for the same reason and fails for the same reason: an entity with
  // six unread articles is not "already up to date".
  const entityCooldownHours = policy.enrichment?.entity_enrich_cooldown_hours ?? 20;
  if (behavior === 'enricher' && entityCooldownHours > 0 && typeIsCoalescible) {
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
      // Record it. This used to return silently, so cooldown skips left no trace
      // anywhere — a workspace could be dropping most of its research here and
      // the event log would show nothing at all. Same shape as the coalesce skip
      // so both read off one query.
      await supabase.from('events').insert({
        workspace_id: payload.workspace_id,
        actor_kind: 'agent',
        actor_id: payload.agent,
        action: 'enrichment_skipped',
        target_kind: 'entity',
        target_id: ent.data.id,
        payload: {
          reason: 'entity_enrich_cooldown',
          entity_id: ent.data.id,
          signal_id: payload.signal_id ?? null,
          signal_type: sigData?.type ?? null,
          cooldown_hours: entityCooldownHours,
        },
        parent_event_id: payload.parent_event_id ?? null,
      });
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
  let pastOutcomesList: Array<{ entity_name: string; gate_policy: string; decision: string; decided_at: string; similarity: number | null; resolution: Record<string, unknown>; draft_excerpt: string | null }> = [];
  let contacts: Array<{ name: string; email: string; role: string; recent_signal?: string }> = [];
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
      // 90d, not 30: decisions are rare (a handful a month), so a 30-day window
      // forgot nearly every human call. limit 5 still caps the token cost.
      const outs = await pastOutcomesFn(supabase, payload.workspace_id, {
        entity_id: ent.data.id, semantic_neighbors: true, limit: 5, since_days: 90,
      });
      pastOutcomesList = outs.map((o) => ({
        entity_name: o.entity_name, gate_policy: o.gate_policy, decision: o.decision,
        decided_at: o.decided_at, similarity: o.similarity, resolution: o.resolution ?? {},
        draft_excerpt: o.draft_excerpt,
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
        // Newest email / role wins. A null supersedes marks the ORIGINAL of a
        // chain, not the current value, so filtering on it would hand the
        // drafter a replaced address or a stale job title — and this is the
        // path that picks the outreach template and the send address.
        // contentFactsRes: each linked contact's own facts, filtered down to
        // real content (a post, a quote -- not role/email bookkeeping) by the
        // same contactContentFacts() definition scoring.ts uses. Read across
        // the works_at edge, never duplicated onto the account.
        const [emailFacts, roleFacts, contactEnts, contentFactsRes] = await Promise.all([
          supabase.from('facts').select('subject_entity, object_text, observed_at')
            .eq('workspace_id', payload.workspace_id).in('subject_entity', contactIds)
            .eq('predicate', 'email'),
          supabase.from('facts').select('subject_entity, object_text, observed_at')
            .eq('workspace_id', payload.workspace_id).in('subject_entity', contactIds)
            .eq('predicate', 'role'),
          supabase.from('entities').select('id, name').in('id', contactIds),
          supabase.from('facts').select('id, subject_entity, predicate, object_text, observed_at, supersedes')
            .eq('workspace_id', payload.workspace_id).in('subject_entity', contactIds),
        ]);
        const emailById = new Map<string, string>();
        const roleById = new Map<string, string>();
        const nameById = new Map<string, string>();
        const latestInto = (rows: Array<{ subject_entity: string; object_text: string; observed_at: string }>, into: Map<string, string>) => {
          const seenAt = new Map<string, string>();
          for (const r of rows) {
            const seen = seenAt.get(r.subject_entity);
            if (seen && r.observed_at <= seen) continue;
            seenAt.set(r.subject_entity, r.observed_at);
            into.set(r.subject_entity, r.object_text);
          }
        };
        latestInto((emailFacts.data ?? []) as Array<{ subject_entity: string; object_text: string; observed_at: string }>, emailById);
        latestInto((roleFacts.data ?? []) as Array<{ subject_entity: string; object_text: string; observed_at: string }>, roleById);
        for (const r of (contactEnts.data ?? []) as Array<{ id: string; name: string }>) nameById.set(r.id, r.name);

        const rawContentFacts = (contentFactsRes.data ?? []) as Array<{ id: string; subject_entity: string; predicate: string; object_text: string | null; observed_at: string; supersedes: string | null }>;
        const contentSupersededIds = new Set(rawContentFacts.map((f) => f.supersedes).filter((x): x is string => !!x));
        const activeContentFacts = contactContentFacts(rawContentFacts.filter((f) => !contentSupersededIds.has(f.id)));
        // Newest qualifying content per contact wins.
        const recentSignalById = new Map<string, string>();
        for (const f of [...activeContentFacts].sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at))) {
          if (!recentSignalById.has(f.subject_entity) && f.object_text) recentSignalById.set(f.subject_entity, f.object_text);
        }

        contacts = contactIds
          .filter((id) => emailById.has(id))
          .map((id) => ({
            name: nameById.get(id) ?? '(unknown)', email: emailById.get(id)!, role: roleById.get(id) ?? '',
            recent_signal: recentSignalById.get(id),
          }))
          .slice(0, 3);
      }
    } catch { /* non-fatal */ }

    // Facts get observed_at stamped at extraction time, which hides how old the
    // underlying event is: a fact extracted today from a January article looks
    // fresh. Recover each fact's real source date from its signal so the craft
    // rules can tell a fresh trigger from theme evidence.
    //
    // Only a genuine published_at counts. This used to fall back to the signal's
    // observed_at, which is when WE crawled the page, so any source we could not
    // date was handed to the drafter looking like it was published the day we
    // found it. Measured on the Sudden book, that covered 96% of active facts and
    // made 2011 accounts look trigger-eligible when only 16 had a fresh dated
    // source. An unknown date must stay unknown: the drafter is told so
    // explicitly, and "undated" is a far cheaper error than a fake trigger.
    try {
      const sigIds = [...new Set(activeFacts.map((f) => f.signal_id).filter((x): x is string => !!x))];
      const dateBySig = new Map<string, string>();
      if (sigIds.length) {
        const srcSigs = await supabase.from('signals')
          .select('id, observed_at, structured_tags')
          .in('id', sigIds);
        for (const s of (srcSigs.data ?? []) as Array<{ id: string; observed_at: string; structured_tags: { published_at?: string | null } | null }>) {
          const pub = s.structured_tags?.published_at;
          if (pub && Number.isFinite(Date.parse(pub))) dateBySig.set(s.id, pub);
        }
      }
      for (const f of activeFacts) {
        f.source_date = f.signal_id ? dateBySig.get(f.signal_id) : undefined;
        f.recorded_date = f.observed_at;
      }
    } catch { /* non-fatal — fact lines render without dates */ }
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
          // Resolved just above from each fact's signal. Without it the recency
          // term ages every fact from its extraction time, which is always ~now.
          source_date: f.source_date,
        })),
        config: (policy as Record<string, unknown>).fact_ranking as Record<string, unknown> | undefined,
      });
    } catch { /* non-fatal */ }
  }

  // Decide WHAT this message argues before the prompt renders a single
  // exemplar, and withhold the bodies of the exemplars that already argue it.
  // One cheap-model call per drafted account; a failure returns null and the
  // prompt renders exactly as it did before, so the picker can never block a
  // draft. Only the template-driven channel has exemplars to withhold.
  let angleDecision: AngleDecision = { choice: null, reason: 'menu_too_small' };
  if (behavior === 'drafter' && (policy.drafter?.templates ?? []).length) {
    angleDecision = await pickDraftAngle(supabase, payload.workspace_id, {
      // The workspace's cheap model, same one classifyRole uses. The drafter
      // itself stays on DRAFTER_MODEL; this call picks an argument, it does
      // not write anything a customer reads.
      model: DEFAULT_MODEL,
      account_name: (ent.data.name as string) ?? '(unnamed)',
      facts: activeFacts.map((f) => ({ predicate: f.predicate, object_text: f.object_text })),
      pain_points: (policy.drafter?.pain_points ?? []) as string[],
      templates: (policy.drafter?.templates ?? []) as Array<{ id: string; angle?: string; enabled?: boolean }>,
    });
  }
  const angle = angleDecision.choice;

  // Resolved once: the prompt is built from it, and the assert loop uses it to
  // force every predicate into a slot rather than trusting the model to.
  const enricherBrief = resolveBrief(policy);
  const systemPrompt = buildSystemPrompt(behavior, about, constitution, ws.data.persona, ws.data.icp, {
    examples: (policy.enrichment?.example_facts ?? []) as Array<{ predicate: string; object_text: string }>,
    banned: (policy.enrichment?.banned_predicates ?? []) as string[],
    resolveEntities,
    edgeVocab,
    nodeTypes,
    brief: enricherBrief,
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
    templates: policy.drafter?.templates,
    angle: angle ? { problem: angle.problem, withheld_template_ids: angle.withheld_template_ids } : undefined,
    message_rules: policy.drafter?.message_rules,
    char_budget: policy.drafter?.char_budget,
    trigger_max_age_days: policy.drafter?.trigger_max_age_days,
    trigger_fresh_days: policy.drafter?.trigger_fresh_days,
    out_of_scope: policy.drafter?.out_of_scope,
  });
  const userPrompt = buildUserPrompt(payload.agent, subName, subSemantic, sigData, ent.data, activeFacts, pastOutcomesList, contacts, recommended, behavior === 'drafter');

  let llm;
  try {
    llm = await chatCompleteForWorkspace(supabase, payload.workspace_id, {
      model,
      behavior,
      // DeepSeek-v4 spends output tokens on reasoning before emitting content;
      // a rich hiring post needs headroom or the JSON body comes back empty.
      // Drafter got 3000 after a high-fact account (53 facts) burned the whole
      // 1500 budget on reasoning and truncated the JSON. It is a cap, not a
      // target, so drafts that finish early still cost what they use.
      max_tokens: behavior === 'drafter' ? 3000 : 1200,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });
  } catch (e) {
    // Record it. Both failure modes here used to return silently, so a workspace
    // whose model was erroring or truncating produced fewer facts and fewer
    // drafts with nothing in the event log to say so — it just looked like a
    // quiet pipeline. A credit wall, a bad model id and a rate limit all land
    // here, and all three are things an operator has to see.
    const message = e instanceof Error ? e.message : String(e);
    // try/catch, not .catch(): the query builder is a thenable, not a Promise,
    // so it has no .catch method. The audit write must never mask the original
    // failure.
    try {
      await supabase.from('events').insert({
        workspace_id: payload.workspace_id,
        actor_kind: 'agent',
        actor_id: payload.agent,
        action: 'agent_llm_failed',
        target_kind: 'entity',
        target_id: ent.data.id,
        payload: { reason: 'llm_error', behavior, model, message: message.slice(0, 400) },
        parent_event_id: payload.parent_event_id ?? null,
      });
    } catch { /* swallow */ }
    return { ok: false, action: 'skip', reason: message, behavior };
  }
  const promptHash = createHash('sha256').update(systemPrompt + '\n' + userPrompt).digest('hex');

  let decision: any;
  try { decision = JSON.parse(llm.text); } catch {
    // Truncation is the usual cause: the model spends its budget on reasoning
    // and the JSON body is cut mid-object. Known live risk since 2026-07-21 on
    // fact-heavy accounts, and until now it was invisible — worth seeing the
    // finish_reason and token counts next to the fragment.
    try {
      await supabase.from('events').insert({
        workspace_id: payload.workspace_id,
        actor_kind: 'agent',
        actor_id: payload.agent,
        action: 'agent_llm_failed',
        target_kind: 'entity',
        target_id: ent.data.id,
        payload: {
          reason: 'unparseable_json', behavior, model,
          output_tokens: llm.output_tokens ?? null,
          max_tokens: behavior === 'drafter' ? 3000 : 1200,
          fragment: (llm.text ?? '').slice(0, 300),
        },
        parent_event_id: payload.parent_event_id ?? null,
      });
    } catch { /* the skip below is what matters */ }
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
    // Keep only quotes that cite an active fact and appear verbatim in the
    // composed body — a hallucinated or mismatched quote just falls back to
    // no inline highlight for that fact, never a broken one.
    const composedLower = composed.toLowerCase();
    const rawCiteQuotes = (decision.cite_quotes ?? []) as Array<{ fact_id?: unknown; quote?: unknown }>;
    const validCiteQuotes = rawCiteQuotes
      .filter((cq): cq is { fact_id: string; quote: string } =>
        typeof cq?.fact_id === 'string' && typeof cq?.quote === 'string' && cq.quote.trim().length > 0)
      .filter((cq) => validCites.includes(cq.fact_id) && composedLower.includes(cq.quote.trim().toLowerCase()))
      .map((cq) => ({ fact_id: cq.fact_id, quote: cq.quote.trim() }));
    const r = await callTool(supabase, actor, 'post_to_channel', {
      channel_id, kind: 'touch_draft', body: composed, cites: validCites, cite_quotes: validCiteQuotes,
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
    // Deterministic draft checks: violations never block the draft. They become
    // one system post under it, so the approval card shows the flag and the
    // human decides informed.
    try {
      const flags = draftAuditFlags({
        body,
        reasoning,
        outreach_channel: outreachChannel,
        char_budget: policy.drafter?.char_budget,
        templates: policy.drafter?.templates,
      });
      if (flags.length) {
        await callTool(supabase, actor, 'post_to_channel', {
          channel_id, kind: 'system', body: `Draft checks: ${flags.join('; ')}`, cites: [], parent_post_id: r.target_id,
        }, meta);
      }
    } catch { /* non-fatal: a failed check must never block the draft */ }
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
          // What the angle picker decided, on the same row as the draft it
          // shaped. Without this, a draft that clones an exemplar anyway is
          // unattributable: you cannot tell whether the picker chose the wrong
          // problem, missed a collision, or was never called at all.
          angle_problem: angle?.problem ?? null,
          angle_why: angle?.why ?? null,
          angle_withheld_template_ids: angle?.withheld_template_ids ?? [],
          angle_outcome: angleDecision.reason,
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
    // The enricher is the only step that reads the whole page, so it is the only
    // place that can see a dateline the URL and the search provider both missed.
    // Fold it back onto the signal so the freshness floor, the age decay, the
    // recency dimension and the drafter all get the real date from here on. It
    // can only ever move a source older or fill a blank (see applyContentDate),
    // so a misread costs one result rather than putting stale news in an email.
    if (sigData?.id) {
      const tags = (sigData.structured_tags ?? {}) as Record<string, unknown>;
      const reported = decision.source_published_date as string | undefined;
      // A date the model read but wrote in the page's own format is refused by
      // parseContentDate, and used to vanish exactly like a page that carried no
      // date: no error, no log, the source quietly keeping the provider's wrong
      // date. Park it on the signal instead, so a format the prompt failed to
      // convert is one SQL query away rather than a replayed enricher call.
      const unreadable = unreadableContentDate(reported);
      const corrected = applyContentDate(tags.published_at as string | null, reported);
      if (unreadable) {
        console.warn(`[enricher] signal ${sigData.id}: source_published_date "${unreadable}" is not YYYY-MM-DD, date not applied`);
        const upd = await supabase.from('signals').update({
          structured_tags: { ...tags, published_at_unreadable: unreadable.slice(0, 64) },
        }).eq('id', sigData.id);
        if (upd.error) console.warn(`[enricher] unreadable source date write failed for signal ${sigData.id}: ${upd.error.message}`);
      } else if (corrected) {
        // Correcting the date is the whole job here. Do NOT also drop the
        // facts: the drafter's craft rules already say age kills events, not
        // state, and a case study from 2022 naming the encoder they run on is
        // still true about their stack today. A drop would delete exactly the
        // evidence those rules keep, and it would delete it silently.
        //
        // What the correction has to do is reach everything downstream that
        // judges age, which now means two writes rather than one. Magnitude was
        // computed at signal creation from the provider's date and never
        // revisited, so a page the provider dated to last week kept a
        // fresh-signal magnitude even after the dateline said 2020.
        const halfLifeDays = policy.research?.decay_half_life_days ?? DEFAULT_DECAY_HALF_LIFE_DAYS;
        const upd = await supabase.from('signals').update({
          structured_tags: {
            ...tags,
            published_at: corrected,
            published_at_source: 'content',
            ...(tags.published_at ? { published_at_reported: tags.published_at } : {}),
          },
          magnitude: researchSignalMagnitude(corrected, halfLifeDays, tags.hook_class as string | undefined),
        }).eq('id', sigData.id);
        if (upd.error) console.warn(`[enricher] source date write-back failed for signal ${sigData.id}: ${upd.error.message}`);
      }
    }

    const facts = (decision.facts ?? []) as Array<{ predicate: string; object_text: string; object_type?: string; domain?: string; confidence: number }>;
    let asserted = 0;
    let assertedSubstantive = false;
    const assertedIds: string[] = [];

    // Fact-level near-dup guard. content_hash catches only byte-identical facts;
    // this skips a reworded restatement of a fact the entity already holds under
    // the SAME predicate (e.g. "Director... (Igor)" vs "Director... Igor"). The
    // threshold is derived, not guessed: on a real book the highest cosine between
    // two GENUINELY-DISTINCT same-predicate facts was 0.9697, so the 0.975 default
    // sits above every distinct pair and cannot drop a real fact. Compares only
    // against pre-existing active facts (never siblings in this batch), so multiple
    // distinct facts from one article are untouched. Fail-open: any embed error
    // asserts normally, since losing a real fact is worse than one duplicate.
    const factDedupSim = policy.enrichment?.fact_dedup_sim ?? 0.975;
    const activeByPredicate = new Map<string, string[]>();
    if (factDedupSim > 0) {
      for (const af of activeFacts) {
        if (!af.object_text || af.predicate.startsWith('score_')) continue;
        const arr = activeByPredicate.get(af.predicate) ?? [];
        arr.push(af.object_text);
        activeByPredicate.set(af.predicate, arr);
      }
    }
    const embedCache = new Map<string, number[]>();
    const embedCached = async (t: string): Promise<number[]> => {
      let v = embedCache.get(t);
      if (!v) { v = await embed(t.slice(0, 500)); embedCache.set(t, v); }
      return v;
    };
    let factDupsSkipped = 0;

    for (const f of facts) {
      if (!f.predicate || !f.object_text) continue;
      const conf = typeof f.confidence === 'number' ? Math.max(0, Math.min(1, f.confidence)) : 0.7;
      const predicate = f.predicate.toLowerCase().replace(/\s+/g, '_');

      // Skip a reworded restatement of an existing same-predicate fact (see above).
      if (factDedupSim > 0) {
        const priors = activeByPredicate.get(predicate);
        if (priors?.length) {
          try {
            const v = await embedCached(f.object_text);
            let maxSim = 0;
            for (const p of priors) {
              const s = cosineSim(v, await embedCached(p));
              if (s > maxSim) maxSim = s;
              if (maxSim >= factDedupSim) break;
            }
            if (maxSim >= factDedupSim) { factDupsSkipped++; continue; }
          } catch { /* fail open: fall through and assert */ }
        }
      }

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
      // Heal missed rescores. If a prior run asserted facts but died before its
      // scoreAndAssert (deploy restart, crash), the retry dedupes every fact →
      // asserted=0 → the score never catches up to the facts. scoreAndAssert's
      // skip-when-stale guard exits before any LLM/embedding spend unless a
      // substantive fact really is newer than the current score, so this is one
      // cheap facts-read per zero-fact run — and a rescore exactly when one was
      // lost.
      try { await scoreAndAssertFn(supabase, actor, ent.data.id); } catch { /* non-fatal */ }
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
      ...(factDupsSkipped > 0 ? { fact_dups_skipped: factDupsSkipped } : {}),
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

/**
 * Everything the drafter prompt can be told about the workspace's outreach.
 * Every field is optional in VALUE — a workspace may not have set it — but see
 * ExplicitDrafterPrompt below for why the key is not optional at the call site.
 */
interface DrafterPromptFields {
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
  templates?: Array<{ id: string; label: string; audience: string; body: string; angle?: string; anatomy?: string; enabled?: boolean }>;
  /** Decided by pickDraftAngle before this prompt is built. See pick_angle.ts. */
  angle?: { problem: string; withheld_template_ids?: string[] };
  message_rules?: string[];
  char_budget?: number;
  trigger_max_age_days?: number;
  trigger_fresh_days?: number;
  out_of_scope?: string[];
}

/**
 * The same fields, but every KEY must be written out at the call site. Values
 * may still be undefined.
 *
 * This exists because the plain all-optional object has no type safety against
 * omission, and this exact call site has silently dropped a field twice:
 * `templates` (f101935 — shipped three days of value-prop garbage before anyone
 * noticed) and `char_budget` (caught just before commit on 07-21). Both times
 * the cause was editing a line in place rather than adding one, and nothing
 * type-errored because every field was optional.
 *
 * Requiring the key turns that class of edit into a compile error. Deleting a
 * line now fails `pnpm typecheck`; the escape hatch when a workspace genuinely
 * has no value is to pass `undefined` explicitly, which is visible in review.
 */
type ExplicitDrafterPrompt = { [K in keyof Required<DrafterPromptFields>]: DrafterPromptFields[K] };

export function buildSystemPrompt(
  behavior: AgentBehavior,
  about: string,
  constitution: string,
  persona: unknown,
  icp: unknown,
  enricherPolicy?: { examples?: Array<{ predicate: string; object_text: string }>; banned?: string[]; resolveEntities?: boolean; edgeVocab?: string[]; nodeTypes?: string[]; brief?: BriefQuestion[] },
  drafterPolicy?: ExplicitDrafterPrompt,
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
    brief: enricherPolicy?.brief ?? [],
  });
  // Spread, do not re-list. This hand-off has now dropped a field three times:
  // `templates` (f101935), `char_budget` (caught pre-commit 2026-07-21), and
  // `angle` (caught by _chk_drafter_prompt.ts, 2026-08-04). Every field is
  // optional on the receiving type, so a key that goes missing type-checks
  // clean and shows up weeks later as a prompt quietly missing a section.
  // Re-listing keys was the bug; there is nothing to re-list now.
  // (outreach_channel used to be the missing one, which is why a linkedin
  // workspace once got the email formula under a "LinkedIn drafter" identity.)
  const drafterDecision = buildDrafterDecision({ ...(drafterPolicy ?? {}) });

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
  /**
   * The workspace's research brief. Empty renders the old open-ended extractor,
   * so a caller that has no brief behaves exactly as before.
   */
  brief?: BriefQuestion[];
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
  // ---- The brief: what this workspace actually needs to know ----
  //
  // The enricher used to be the ONLY stage of research with no idea what the
  // workspace sells. Its instructions were "extract atomic claims" plus "go
  // deep", and a list of example fact SHAPES. So on a workspace selling delivery
  // capacity to streaming companies it faithfully wrote down a Pilates studio's
  // equipment requirements, a broadcaster's LinkedIn follower growth, and a
  // media company's 2021 award shortlist — 795 facts in a week across 488
  // distinct predicates, 79% of which were never used again by anything.
  //
  // Two changes. The model is told the QUESTIONS the workspace needs answered,
  // and every fact must name the one it answers. And the question's id becomes
  // the predicate's namespace, so the vocabulary can no longer sprawl: the
  // prefix is fixed by the brief, only the suffix is the model's to pick.
  const brief = (opts.brief ?? []).filter((q) => q?.id && q?.question);
  const briefBlock = brief.length
    ? `WHAT THIS WORKSPACE NEEDS TO KNOW. These are the only questions worth answering about a prospect. Extract a fact ONLY when it answers one of them:

${brief.map((q) => `  [${q.id}] ${q.question}${q.why ? `\n        why it matters: ${q.why}` : ''}`).join('\n')}

Name each fact in plain lowercase_with_underscores for the thing it records. Reuse the exact name an ACTIVE FACT already uses when you are recording the same kind of thing — a near-synonym for something already recorded is the single most common way this data becomes unusable.

IF A DETAIL ANSWERS NONE OF THESE QUESTIONS, DO NOT EXTRACT IT. Not as a fact with a different name, not "just in case", not because it is interesting or specific or true. Awards, follower counts, subscription prices, catalogue contents, app-store ratings, office perks, and descriptions of the company's category are the usual temptations. The test is not "is this true about the company" — it is "does a person reading the questions above see this as an answer to one of them". Extracting nothing from a page is a correct and common outcome.

The examples below show the LEVEL OF SPECIFICITY the workspace wants. They are not a list of things to look for, and their names predate this scheme:
${examples}

`
    : `DO extract specific claims grounded in the signal. The kinds of facts that matter for THIS workspace look like:
${examples}

(These are the workspace's example shapes — extract anything that fits the same level of specificity, not literally these only.)

`;

  // DEPTH, scoped by the brief when there is one. The old version told the model
  // to "go deep" on any rich payload, which on a long page meant thirty facts
  // about whatever the page happened to cover.
  const depthBlock = brief.length
    ? `DEPTH. A rich payload — a long post, a press release, a detailed write-up — usually answers ONE or TWO of the questions above properly, and mentions a dozen things that answer none. Go deep on the ones it genuinely answers: if it carries three separate figures that answer the same question, that is three facts, and each gets its own suffix. Do not pad the list with the things it merely mentions.
Stay on the SUBJECT company. A detail that describes the internals of the artifact rather than the company is not a fact about the company: from a job posting, that the company is hiring for role X answers a question, while the checklist of what they want in a candidate describes a hypothetical hire and answers nothing. The test for each fact: is this a claim about the company, or about the contents of this one artifact?
One predicate, one object — never collapse multiple details into a single fact. Confidence 0.95 when explicit, 0.7 when strongly implied.`
    : `DEPTH (when the signal carries a rich payload — a long post, a detailed listing, a press release — go deep, but stay on the SUBJECT company). Extract details that describe THIS company: what it builds, sells, or offers; who it serves; its stage, size, stack, funding, customers, partners; a notable thing it's doing (launched / hired / raised / shipped); and any pain — plus one short summary fact of the event itself. Do NOT extract details that only describe the internals of the artifact rather than the company. Concretely: a job posting's required skills, years of experience, nice-to-haves, and ideal-candidate traits describe a hypothetical hire, not the company — from a job posting, capture that the company is hiring for role X (and any pain the posting implies about why), NOT the checklist of what they want in a candidate. The test for each fact: is it a claim about the company, or about the contents/spec of this one artifact? Keep the first, drop the second. Reuse a predicate the workspace examples or the entity's ACTIVE FACTS already use; coin a new lowercase predicate only when none fits, and never split one idea across near-synonym predicates (e.g. requirement / requires / required_attribute). One predicate, one object — never collapse multiple details into a single fact. If the payload is empty or generic, extract only what's actually there and skip the rest. Confidence 0.95 when explicit, 0.7 when strongly implied.`;

  // Pain is the one thing the brief must never be able to switch off: a problem
  // in the prospect's own words is what every outbound message is ultimately
  // about. resolveBrief appends it rather than generating it, so no settings
  // edit can drop it.
  const painPred = 'pain_observed';
  const painExample = 'pain_observed';
  const painBlock = `PAIN EXTRACTION (second pass) — separately from the facts above, extract any pain, frustration, complaint, unmet need, manual-toil pattern, or expressed limitation the source describes. Use predicate "${painPred}" and an object_text that captures the pain in concrete terms, preferring the source's own wording where possible. Each entry goes in the SAME facts[] array as the facts above and MUST include the confidence field (0.95 directly stated, 0.7 strongly implied) — same JSON schema, no separate section. Examples (these are SHAPES, not a closed list — extract anything that fits regardless of vertical):
- ${painExample} = "founder writing every outbound email personally, no time to scale"
- ${painExample} = "current tooling forces context switches between 4 apps daily"
- ${painExample} = "took 3 weeks to ship last marketing email due to legal review"
- ${painExample} = "considered hiring SDR but couldn't justify the cost at current revenue"

Pain is usually expressed indirectly. Look for: complaints ("we hate / can't / wish"), descriptions of manual work ("we still do X by hand"), references to gaps ("we don't have X yet"), or descriptions of friction ("X takes us Y hours / weeks"). Statements about challenges, constraints, manual workarounds, or what doesn't work today ARE pain — extract them even when stated calmly and factually, not just when emotionally vented. Do not split the same pain across this slot and a separate one like has_challenge or seeks_solution. Skip if the source is purely positive / promotional / announcement-only with no friction language. Confidence 0.95 if directly stated, 0.7 if strongly implied. Do not invent pains that aren't on the page.`;

  const objSchema = opts.resolveEntities
    ? `{"predicate":"<verb_or_attribute>","object_text":"<value or entity name>","object_type":"<${nodeTypeList.join('|')}|literal>","domain":"<website if object_type is an org; else omit>","confidence":0.0-1.0}`
    : `{"predicate":"<verb_or_attribute>","object_text":"<value>","confidence":0.0-1.0}`;

  return `A new signal arrived about the account in the user message. Extract atomic factual claims about THIS entity that are supported by the signal AND that the system doesn't already know.

IDENTITY CHECK (do this first) — companies and people can share a name. Cross-check the signal's content and source URL (in SIGNAL.structured_tags) against this account's own ATTRIBUTES (domain, website, industry, description) in the user message. If the signal clearly describes a different organization that merely shares this name — different domain, different industry, different product — treat it as nothing extractable: output {"facts":[],"summary":"skipped: signal describes a different entity with the same name","reasoning":"<what mismatched>"}.

DO NOT extract:
- Anything already present in the entity's ATTRIBUTES (the JSON object in the user message). The values there are authoritative; re-asserting them as facts is noise.
- Anything already present in the ACTIVE FACTS list — including a REWORDED version of it. If an active fact already states this, even in different words, order, or punctuation, do NOT emit it again. Only emit a fact about the same thing when it changes a SPECIFIC value (a corrected number, a new named detail) — and then state the new value explicitly so it reads as an update, not a paraphrase.
- Generic descriptors that are obvious from the entity name or category.${bannedLine}

${briefBlock}Each claim should be:
- ATOMIC: one predicate, one object. Not "uses postgres and redis."
- VERBATIM-GROUNDED: only what's stated or directly implied. No speculation.

Use object_text for the value. Confidence: 0.95 explicit, 0.7 implied. Skip lower.${relBlock}

${painBlock}

${depthBlock}

SOURCE DATE — include a "source_published_date" field: the date this SOURCE was published, in YYYY-MM-DD form, but ONLY if the content itself states it. Read it off a byline, a dateline, a "Posted on", a press-release header, or an explicit sentence about when the piece was written. Use "" when the content does not say. This matters because search engines routinely report the date they crawled a page instead of the date it was written, which has put years-old articles in front of prospects as if they were this week's news; the date printed on the page is the reliable one.
Rules: report the date the SOURCE was published, never a date it merely mentions. "Launched in November 2022", "the 2024 season", or a conference happening next March are events being described, NOT the publication date. If the page only carries an event date and no publication date, return "". Do not estimate, infer from context, or guess a year. If the page shows only a day and month with no year, return "".
More than one date: forums, aggregators and scraper sites republish an article under their own timestamp, so the page carries the copier's date above the original writer's byline. When two or more dates on a page could each be a publication date, report the EARLIEST one. A copy is always stamped after the thing it copied, so the oldest of them is the closest to when the piece was actually written. Observed live: a FloSports story published 2025-03-28, reposted by a user account on 2026-07-28, where taking the top date turned a 16-month-old deal into last week's news. This does not loosen the rule above: an event the piece merely describes is still never the publication date, however early on the page it appears.
Format: pages almost never print a date the way this field wants it, so converting it is your job. "23/04/2026" becomes "2026-04-23"; "7 juillet 2025" becomes "2025-07-07"; "July 7, 2025" becomes "2025-07-07". Anything that is not four-digit year, two-digit month, two-digit day is thrown away as if the page had carried no date at all. For an all-numeric date, read the day/month order the way the page's own language and country write it: French, Spanish, German and British English put the day first, US English puts the month first, and any number above 12 can only be the day. If both numbers are 12 or under and nothing on the page settles the order, return "".

REASONING — include a "reasoning" field explaining why you picked these facts (or why you skipped). 1-2 sentences. This becomes a separate "decision" post so the audit trail explains the extraction.

Output strictly valid JSON:
{"facts":[${objSchema},...],"source_published_date":"<YYYY-MM-DD, or empty string>","summary":"<1 sentence>","reasoning":"<why these facts, 1-2 sentences>"}

If nothing genuinely new is extractable, output {"facts":[],"summary":"No new facts; data already known or signal too vague.","reasoning":"<why nothing new>"}`;
}

/**
 * How a fact's age is stated to the agent.
 *
 * The two cases are kept visibly different because they mean different things.
 * "published" is evidence of when something actually happened and can anchor a
 * trigger-led message. "undated" means the source carried no date and the only
 * date we hold is our own filing date, which says nothing about when the event
 * happened. Collapsing the second into the first is what let a 2015 page read as
 * this week's news; see the source-date recovery above.
 */
function factDateLabel(f: { source_date?: string; recorded_date?: string }): string {
  if (f.source_date) return `, published ${f.source_date.slice(0, 10)}`;
  if (f.recorded_date) return `, undated source, we recorded it ${f.recorded_date.slice(0, 10)}`;
  return '';
}

export function buildUserPrompt(
  agentId: string,
  subName: string,
  subSemantic: string,
  signal: any,
  entity: { id: string; name: string; attributes: unknown },
  activeFacts: Array<{ id: string; predicate: string; object_text: string | null; confidence: number; source_date?: string; recorded_date?: string }>,
  pastOutcomesList: Array<{ entity_name: string; gate_policy: string; decision: string; decided_at: string; similarity: number | null; resolution: Record<string, unknown>; draft_excerpt?: string | null }> = [],
  contacts: Array<{ name: string; email: string; role: string; recent_signal?: string }> = [],
  recommended: FactScore[] = [],
  // Drafters get attributes as readable prose so the email never echoes internal
  // field names ("domain", "stack"). The enricher keeps raw JSON keys — it needs
  // them to know what's already extracted and avoid re-asserting.
  proseAttributes = false,
): string {
  // Strip embedding from signal (massive vector adds nothing for the LLM and burns tokens).
  const { embedding: _e, ...signalForPrompt } = signal ?? {};

  const pastOutcomesBlock = pastOutcomesList.length
    ? `\nPAST OUTCOMES (how the human decided recent drafts for this account or similar ones. Edits are corrections: the "→" side is the wording the human wanted, so write your draft as if it had already been edited that way. A rejection means do not repeat that draft's approach. An approval with no edits is the standard to match):\n${pastOutcomesList.map((o) => {
        const sim = o.similarity != null ? ` sim=${o.similarity.toFixed(2)}` : '';
        const res = o.resolution ?? {};
        const parts: string[] = [];
        if (typeof res.note === 'string' && res.note) parts.push(`note: "${res.note}"`);
        if (res.edited) {
          const sd = res.subject_diff as { from: string; to: string } | undefined;
          const bd = res.body_diff as Array<{ from: string; to: string }> | undefined;
          if (sd) parts.push(`subject: "${sd.from}" → "${sd.to}"`);
          if (bd?.length) parts.push(`body: ${bd.map((d) => `"${d.from}" → "${d.to}"`).join('; ')}`);
        } else if (o.decision === 'approve' && o.draft_excerpt) {
          // Sent exactly as drafted: the excerpt is a positive example worth ~30 tokens.
          parts.push(`sent as written: "${o.draft_excerpt}"`);
        }
        const detail = parts.length ? ` — ${parts.join('; ')}` : '';
        return `  ${o.decided_at.slice(0, 10)} ${o.entity_name}${sim}: ${o.decision} (policy=${o.gate_policy})${detail}`;
      }).join('\n')}\n`
    : '';

  const contactsBlock = contacts.length
    ? `\nCONTACTS (linked to this account — pick the best fit for the role you're targeting):\n${contacts.map((c) => `  ${c.name} <${c.email}>${c.role ? ` — ${c.role}` : ''}${c.recent_signal ? `\n    recently said: ${c.recent_signal}` : ''}`).join('\n')}\n`
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
${activeFacts.length ? activeFacts.map((f) => `  ${f.id} | ${f.predicate}=${f.object_text} (conf=${f.confidence}${factDateLabel(f)})`).join('\n') : '  (none yet)'}
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
    // Numeric ranges first: "60–80%" must read "60 to 80%", not "60, 80%"
    // (the comma splice garbled every draft quoting a savings range).
    .replace(/(\d)\s*[—–]\s*(?=\d)/g, '$1 to ')
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
 * Deterministic post-draft checks. Violations never block a draft — each run's
 * output is one string per problem, joined into a single `system` post under
 * the draft, so the approval card carries the flag and the human decides
 * informed. The shapes live here; the thresholds (char_budget, templates) are
 * workspace config.
 */
export function draftAuditFlags(args: {
  body: string;
  reasoning: string;
  outreach_channel: 'email' | 'linkedin';
  char_budget?: number;
  templates?: Array<{ id: string; label: string; audience: string; body: string; enabled?: boolean }>;
}): string[] {
  const flags: string[] = [];
  // Same usability filter as buildDrafterDecision: these are the templates the
  // model actually saw, numbered [1..n] in prompt order.
  const usable = (args.templates ?? []).filter((t) => t && t.enabled !== false && t.body?.trim() && t.audience?.trim());
  const templated = args.outreach_channel === 'linkedin' && usable.length > 0;

  // Mirror the prompt's effective budget: explicit config wins, the
  // template-driven DM path defaults to 400, otherwise no budget to check.
  const budget = args.char_budget ?? (templated ? 400 : undefined);
  if (budget && args.body.length > Math.round(budget * 1.1)) {
    flags.push(`draft is ${args.body.length} chars, budget ${budget}`);
  }

  const url = args.body.match(/https?:\/\/\S+|\bwww\.\S+/i);
  if (url) {
    flags.push(`draft contains a link (${url[0].slice(0, 60)}); links in a first touch hurt reply rates`);
  }

  // Craft checks, same shapes for every workspace (see OUTREACH_CRAFT in
  // prompt_builders.ts). These catch the two failure modes the prompt alone
  // didn't stop: a message that asks for calendar time, and a message with no
  // question in it at all. Customer-specific phrase bans are NOT here — those
  // live in policy.outreach.banned_phrases.
  const TIME_ASKS: Array<[RegExp, string]> = [
    [/\bopen to a (quick |brief |short )?(chat|call|conversation)\b/i, 'asks for a chat instead of offering something'],
    [/\bworth a (quick |brief |short )?(chat|call)\b/i, 'asks for a call instead of offering something'],
    [/\b\d{1,2}\s*(-|\s)?\s*(min|minute)s?\b/i, 'proposes a meeting length'],
    [/\b(can|could) we (sync|connect|hop on|jump on)\b/i, 'asks for a meeting'],
    [/\b(calendly|savvycal|cal\.com)\b/i, 'contains a scheduling link'],
    [/\b(does|would) (next |this )?(week|tuesday|wednesday|thursday|monday|friday) work\b/i, 'proposes a specific day'],
  ];
  for (const [re, why] of TIME_ASKS) {
    const m = args.body.match(re);
    if (m) { flags.push(`CTA ${why}: "${m[0]}" — offer to do the work or give them an easy out instead`); break; }
  }

  if (!args.body.includes('?')) {
    flags.push('no question in the draft; the reader has nothing cheap to answer');
  }

  if (templated) {
    const r = args.reasoning.toLowerCase();
    const named = usable.some((t, i) =>
      (t.id && r.includes(t.id.toLowerCase())) ||
      (t.label && r.includes(t.label.toLowerCase())) ||
      r.includes(`[${i + 1}]`) || r.includes(`template ${i + 1}`));
    if (!named) flags.push('reasoning does not name which template it used');
  }
  return flags;
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
    // Newest domain wins. Filtering on a null supersedes would return the
    // FIRST domain ever asserted — a correction is written as a new row
    // pointing back at the one it replaces — so a fixed domain would keep
    // resolving to the broken original and every contact pull for the account
    // would go on querying the wrong company.
    const f = await supabase.from('facts').select('object_text')
      .eq('workspace_id', actor.workspace_id).eq('subject_entity', entity_id)
      .eq('predicate', 'domain').order('observed_at', { ascending: false })
      .limit(1).maybeSingle();
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
