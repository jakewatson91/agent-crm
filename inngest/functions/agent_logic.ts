/**
 * Pure agent logic: load context -> pre-LLM checks -> LLM -> structured action -> tool dispatch.
 *
 * Branches on subscription.agent_behavior:
 *   - 'claim_poster' (default): produces post_claim or request_gate
 *   - 'drafter':                  produces post_touch_draft (email-shaped) or request_gate
 *
 * Provider routing: subscription.model decides where the LLM call goes.
 *   - bare model id (e.g. "gpt-4o-mini")            -> OpenAI direct
 *   - slash-prefixed (e.g. "deepseek/...")           -> OpenRouter
 *
 * Prompt cache discipline: the system message contains ONLY workspace-stable
 * content (about, constitution, decision instructions, output format). Per-run
 * variable content (agent identity, signal, facts) goes in the user message.
 * That means OpenAI's prompt cache hits on the system message across many runs
 * in the same workspace — ~50% input-token discount on the cached portion.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { callTool, pastOutcomes as pastOutcomesFn, findContacts as findContactsFn, linkContactToAccount as linkContactFn, scoreAndAssert as scoreAndAssertFn, selectAction, loadActionContext, type WorkspacePolicy } from '@agent-crm/tools';
import { chatComplete } from '@agent-crm/primitives';
import { createHash } from 'node:crypto';
import { inngest } from '../client.js';

// Default routing: every behavior except drafter uses Flash:free via OpenRouter.
// Drafter is the user-visible output — pay for Pro quality. Both are slash-
// prefixed → chatComplete sends them to OpenRouter (OPENROUTER_API_KEY).
const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash:free';
const DRAFTER_MODEL = 'deepseek/deepseek-v4-pro';

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
  if (payload.signal_id) {
    const sig = await supabase
      .from('signals')
      .select('id, entity_id, type, magnitude, body_for_embedding, observed_at, structured_tags')
      .eq('id', payload.signal_id).single();
    if (sig.error || !sig.data) return { ok: false, action: 'skip', reason: `signal ${payload.signal_id} not found` };
    sigData = sig.data as unknown as typeof sigData;
    triggerEntity = sig.data.entity_id;
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
    .select('id, predicate, object_text, confidence, supersedes, created_at')
    .eq('subject_entity', ent.data.id);
  if (allFacts.error) return { ok: false, action: 'skip', reason: `facts query failed: ${allFacts.error.message}` };
  const factRows = (allFacts.data ?? []) as Array<{ id: string; predicate: string; object_text: string | null; confidence: number; supersedes: string | null; created_at: string }>;
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

  // 5. Channel.
  const chan = await supabase
    .from('channels').select('id')
    .eq('workspace_id', payload.workspace_id).eq('account_entity_id', ent.data.id).maybeSingle();
  if (chan.error || !chan.data) return { ok: false, action: 'skip', reason: 'no channel for entity' };
  const channel_id = chan.data.id as string;

  const actor = { workspace_id: payload.workspace_id, actor_kind: 'agent' as const, actor_id: payload.agent };

  // ============================================================
  // Pre-LLM deterministic checks. Each one that fires emits a `decision` post
  // (no gate) and returns. Gates are only for irreversible actions a human
  // must approve — see CLAUDE.md. Operational rejections by the agent itself
  // are audit-trail entries, not human work.
  // ============================================================

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

  // Value-theme match info from action_selector — hoisted so the drafter
  // prompt below can read it after the action_selector block scope closes.
  let matchedTheme: string | null = null;
  let matchedEvidence: string | null = null;
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
    // Strip admin / score / lookup-cache / source-bookkeeping facts before
    // passing to action_selector — value-theme matching should see real claims
    // about the entity, not connector breadcrumbs. The Exa pipeline asserts
    // facts like `query=...`, `intent=discover`, `item_url=...` which are the
    // search context that surfaced the entity, not facts about it.
    const ADMIN_FOR_THEMES = new Set([
      'icp_fit', 'icp_fit_breakdown', 'domain', 'contact_lookup_attempted',
      'dropped_until', 'outreach_cooldown_until', 'last_outreach_at',
      'research_triggered', 'research_completed', 'score_total',
      'no_reply_marked', 'outreach_rejected_at', 'replied_at',
      // Source bookkeeping — value statements about the SEARCH, not the entity:
      'query', 'intent', 'item_url', 'published_at', 'matched_alias',
      'topic', 'source_url', 'source_title',
    ]);
    const substantiveFacts = activeFacts
      .filter((f) => !ADMIN_FOR_THEMES.has(f.predicate) && !f.predicate.startsWith('score_'))
      .map((f) => ({ predicate: f.predicate, object_text: f.object_text }));
    const valueThemes = policy.drafter?.value_themes ?? [];
    const decision = selectAction({
      workspace_id: payload.workspace_id,
      entity_id: ent.data.id,
      breakdown: scoreBreakdown,
      icp_total: icpTotal,
      recent_draft_at: ctx.recent_draft_at,
      recent_research_at: ctx.recent_research_at,
      dropped_until: ctx.dropped_until,
      cooldown_until: ctx.cooldown_until,
      facts: substantiveFacts,
      value_themes: valueThemes,
    });
    matchedTheme = (decision as { matched_theme?: string | null }).matched_theme ?? null;
    matchedEvidence = (decision as { matched_evidence?: string | null }).matched_evidence ?? null;

    if (decision.action !== 'draft_outreach') {
      // Only post state-changing actions to the channel. watch_only and continue
      // produce no observable change, so they're audit-trail events only — the
      // feed stays focused on actions the user cares about.
      const cites = activeFacts.filter((f) => f.predicate.startsWith('score_')).map((f) => f.id);
      const STATE_CHANGING: ReadonlySet<typeof decision.action> = new Set(['deep_research', 'drop']);
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
        // tick. Action selector reads this via recent_research_at.
        await callTool(supabase, actor, 'assert_fact', {
          subject_entity: ent.data.id,
          predicate: 'research_triggered',
          object_text: new Date().toISOString(),
          confidence: 1.0,
        });
        // Fire the inngest event the source-runner will consume to pull more
        // facts via Exa scoped to this entity.
        try {
          await inngest.send({
            name: 'research.requested',
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
  let pastOutcomesList: Array<{ entity_name: string; gate_policy: string; decision: string; decided_at: string; similarity: number | null }> = [];
  let contacts: Array<{ name: string; email: string; role: string }> = [];
  if (behavior === 'drafter') {
    try {
      const outs = await pastOutcomesFn(supabase, payload.workspace_id, {
        entity_id: ent.data.id, semantic_neighbors: true, limit: 5, since_days: 30,
      });
      pastOutcomesList = outs.map((o) => ({
        entity_name: o.entity_name, gate_policy: o.gate_policy, decision: o.decision,
        decided_at: o.decided_at, similarity: o.similarity,
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

  const systemPrompt = buildSystemPrompt(behavior, about, constitution, ws.data.persona, ws.data.icp);
  // matched_theme / matched_evidence come from action_selector. When set, the
  // drafter prompt below uses them as PRIMARY_ANGLE so the LLM leads with the
  // value-prop theme instead of grabbing the first fact in the list.
  const userPrompt = buildUserPrompt(payload.agent, subName, subSemantic, sigData, ent.data, activeFacts, pastOutcomesList, contacts, matchedTheme, matchedEvidence);

  let llm;
  try {
    llm = await chatComplete({
      model,
      max_tokens: behavior === 'drafter' ? 700 : 400,
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
  const meta = { prompt_hash: promptHash, parent_event_id: payload.parent_event_id };
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
    const subject = sanitize((decision.subject as string) ?? '');
    const body = sanitize((decision.body as string) ?? '');
    const toEmail = ((decision as { to_email?: string | null }).to_email ?? '').toString().trim();
    const toLine = toEmail ? `To: ${toEmail}\n` : '';
    const composed = subject ? `${toLine}Subject: ${subject}\n\n${body}` : `${toLine}${body}`;
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
        to_email: toEmail || null,
        subject,
        body,
        entity_id: ent.data.id,
        entity_name: ent.data.name,
      },
    }, meta);
    // Auditable decision post explaining why we drafted. Cites the same facts so the
    // provenance walk works from either the draft or the decision.
    const reasoning = sanitize(((decision as { reasoning?: string }).reasoning ?? '').toString());
    if (reasoning) {
      await callTool(supabase, actor, 'post_to_channel', {
        channel_id, kind: 'decision', body: reasoning, cites: validCites, parent_post_id: r.target_id,
      }, meta);
    }
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
    const facts = (decision.facts ?? []) as Array<{ predicate: string; object_text: string; confidence: number }>;
    let asserted = 0;
    const assertedIds: string[] = [];
    for (const f of facts) {
      if (!f.predicate || !f.object_text) continue;
      const conf = typeof f.confidence === 'number' ? Math.max(0, Math.min(1, f.confidence)) : 0.7;
      const r = await callTool(supabase, actor, 'assert_fact', {
        subject_entity: ent.data.id,
        predicate: f.predicate.toLowerCase().replace(/\s+/g, '_'),
        object_text: f.object_text,
        confidence: conf,
      }, meta);
      if (r.ok) { asserted++; assertedIds.push(r.target_id); }
      // Per-fact failures don't bubble — the run is still useful with N-1 facts.
    }
    // Only post when we extracted something. Zero-fact runs become audit-trail
    // events instead of channel noise. The summary still lives in the LLM's
    // output if needed for debugging — it's just not surfaced as a "claim."
    let post: { ok: boolean; target_id?: string; error?: string } = { ok: false };
    if (asserted > 0) {
      const summary = sanitize((decision.summary as string) ?? `Extracted ${asserted} fact${asserted === 1 ? '' : 's'}.`);
      post = await callTool(supabase, actor, 'post_to_channel', {
        channel_id, kind: 'claim', body: summary, cites: assertedIds,
      }, meta);
      const reasoning = sanitize(((decision as { reasoning?: string }).reasoning ?? '').toString());
      if (reasoning && post.ok) {
        await callTool(supabase, actor, 'post_to_channel', {
          channel_id, kind: 'decision', body: reasoning, cites: assertedIds, parent_post_id: post.target_id,
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
    // Auto-fetch contacts if the entity has a domain and no contacts yet.
    // Runs once per entity (idempotent on email). Customer opts in by setting
    // policy.enrichment.contact_provider = 'hunter'; default 'none' means a
    // brand-new workspace doesn't make surprise Hunter calls.
    if (policy.enrichment?.contact_provider === 'hunter' && process.env.HUNTER_API_KEY) {
      const linked = await maybeLinkContactsForEntity(supabase, actor, ent.data.id, channel_id, meta);
      if (linked > 0) {
        await callTool(supabase, actor, 'post_to_channel', {
          channel_id, kind: 'system', body: `Linked ${linked} contact${linked === 1 ? '' : 's'} via Hunter.io.`,
        }, meta);
      }
    }
    // Auto-score: only re-run when the enricher actually asserted new facts.
    // Score is a pure function of facts; identical facts in = identical score out,
    // so skipping when nothing changed saves the LLM + 4 embedding calls per
    // scoreEntity invocation. scoreEntity has its own guard as defense-in-depth.
    // Post the score reasoning only on band change — the band maps to downstream
    // action_selector thresholds, so a band shift is what actually changes behavior.
    if (asserted > 0) {
      try {
        const priorScoreText = activeFacts.find((f) => f.predicate === 'score_total')?.object_text
          ?? activeFacts.find((f) => f.predicate === 'icp_fit')?.object_text;
        const priorScore = priorScoreText ? parseFloat(priorScoreText) : NaN;
        const score = await scoreAndAssertFn(supabase, actor, ent.data.id);
        if (score && (!Number.isFinite(priorScore) || icpBand(priorScore) !== icpBand(score.icp_fit))) {
          const reasoning = `ICP fit ${score.icp_fit.toFixed(2)} (${icpBand(score.icp_fit)}) — ${score.reasoning}`;
          await callTool(supabase, actor, 'post_to_channel', {
            channel_id, kind: 'decision', body: reasoning, cites: assertedIds,
          }, meta);
        }
      } catch {
        // Non-fatal: enrichment is still useful without the score.
      }
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
): string {
  const identity = behavior === 'drafter'
    ? 'You are an outbound-email drafter for an agent-native CRM.'
    : behavior === 'enricher'
    ? 'You are a fact extractor for an agent-native CRM. You read incoming signals and turn them into atomic, citable claims about entities.'
    : 'You are an autonomous CRM agent.';

  const aboutBlock = about
    ? `\n\nABOUT THIS COMPANY (what we sell, who we sell to, how we're different):\n${about}`
    : `\n\nWorkspace persona: ${JSON.stringify(persona)}.\nWorkspace ICP: ${JSON.stringify(icp)}.`;

  const constitutionBlock = constitution
    ? `\n\nWORKSPACE CONSTITUTION (applies to every action — voice, do-nots, brand rules):\n${constitution}`
    : '';

  const decisionBlock = behavior === 'drafter' ? DRAFTER_DECISION
    : behavior === 'enricher' ? ENRICHER_DECISION
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

const DRAFTER_DECISION = `A new high-fit signal matched your saved filter rule. Draft an outbound email to the account in the user message, following the formula below exactly.

EMAIL FORMULA — 4 parts, in this order, each separated by a blank line:

1. SUBJECT — exactly ONE word. A concrete noun, ideally tied to the specific signal that triggered this. Examples: "Tokens", "Founding-GTM", "Pricing", "Stack", "Burn". Never vague words like "Hello", "Question", "Quick", "Connect".

2. ACCUSATION AUDIT — one short sentence acknowledging this is a cold email and disarming. Pick a phrasing that fits the moment, e.g.:
   - "Hope you don't mind the cold connect."
   - "You might hate me for the cold email."
   - "Quick cold note, I'll keep it short."
   Don't apologize twice. Don't qualify it. One sentence, then move on.

3. PROBLEM STATEMENT — 1-2 sentences naming the specific pain orgs EXACTLY LIKE THIS ACCOUNT hit. Use the entity's facts/attributes to specialize. The pain space we speak to (pick what fits the prospect, don't list all):
   - Running GTM with 1-2 people plus agents on top of HubSpot/Salesforce, bolt-on systems built for humans
   - Token bloat: agents reading raw row dumps from legacy CRMs eat 5-10x the tokens they need to
   - Last-write-wins on shared accounts: when multiple agents update the same row, data silently disappears
   - No provenance: agents make claims your customer can't verify
   Tie the problem to a specific fact about THIS account if you can (small team, recent fundraise, AI-forward stack).

4. ONE-LINER on the concrete thing we do — exactly 1 sentence. State a CONCRETE FACT about how the system behaves. Pick one that connects to the problem statement above:
   - "When 3 of your agents update the same account at once, all 3 writes land. We benchmarked HubSpot losing 96%."
   - "Every line in this email cites a fact you can trace back to the signal it came from."
   - "Agents read 1.28x fewer tokens because the system projects rows for agents, not for humans clicking through tabs."
   - "You see things only when policy says you should. The default home screen is empty when nothing needs you."

   BANNED PHRASES (do NOT use any variant): "AI-native CRM", "agent-native CRM", "agent-native architecture", "agent-native approach", "optimizes workflows", "optimizes agent workflows", "built for agents", "purpose-built for X", "redefining the way", "reimagining". These are filler. The reader has heard them 100 times this week. Use a concrete behavior or a number instead.

5. ASK — short. "Worth exploring?" or "Open to a 15-min chat?" or "Want to see it run?". One sentence.

RECIPIENT — if CONTACTS are present in the user message, pick the best fit for the angle (founder/CEO for cold outreach to early-stage; RevOps lead or VP Sales for ops-tool pitch; CTO for technical depth). Echo the chosen email in your output's "to_email" field so the audit trail records who this draft is addressed to. If no CONTACTS, set "to_email" to null.

Total: subject is one word; body covers parts 2-5 in order. Single paragraph or split into a few — your call based on what reads naturally. No transitional fluff between parts.

Voice and hard rules come from the workspace constitution above. Constitution wins over this formula on tone — if the constitution says "no em dashes" or "no jargon," follow that strictly even if the formula's example uses them.

The decision to draft has already been made upstream — a deterministic action selector ran the rubric scores against thresholds before invoking you. You are here because the entity cleared all the bars: icp_total ≥ 0.65, signal_strength ≥ 0.7, evidence_depth ≥ 0.5, no draft in the past 14d. Your job is to WRITE the email, not to second-guess whether it should be written.

If the active facts genuinely don't give you enough to write something concrete (you'd be reaching for generic phrases), output {"action":"request_gate","body":"<one sentence: what specific fact you'd need>","policy":"facts_insufficient_for_draft"} — but that's a rare escape hatch, not the default path.

REASONING — every post_touch_draft output MUST include a "reasoning" field: 1-2 sentences explaining which 2-3 facts you anchored to. This becomes a separate "decision" post in the channel so the human auditor can see why each draft happened.

Output strictly valid JSON, no preamble:
{"action":"post_touch_draft","subject":"<one word>","body":"<email body, 4 short paragraphs separated by blank lines>","cites":["<fact_id_uuid>",...],"reasoning":"<which facts you anchored to, 1-2 sentences>","to_email":"<picked contact email or null>"}`;

const ENRICHER_DECISION = `A new signal arrived about the account in the user message. Extract atomic factual claims about THIS entity that are supported by the signal AND that the system doesn't already know.

DO NOT extract:
- Anything already present in the entity's ATTRIBUTES (the JSON object in the user message). The values there are authoritative; re-asserting them as facts is noise.
- Anything already present in the ACTIVE FACTS list. Those exist; don't duplicate.
- Generic descriptors that are obvious from the entity name or industry ("is a company", "is in tech").

DO extract claims that ARE in the signal AND aren't already in attributes/active facts:
- New hiring intent (specific role, department, location): "hiring_senior_typescript_engineer", "hiring_for=GTM"
- Technology mentions not already in attributes: integrations, partnerships, customer references
- Funding events: "raised_round=Series A 12M led by Sequoia"
- Product events: "launched_product=X", "deprecated_product=Y"
- Strategic positioning: "target_market=mid_market_fintech"
- Personnel: new hires, departures, founder activities
- Customer/partner mentions: "customer_of=Acme", "integrates_with=Snowflake"

Each claim should be:
- ATOMIC: one predicate, one object. Not "uses postgres and redis."
- VERBATIM-GROUNDED: only what's stated or directly implied. No speculation.

Use object_text for the value. Confidence: 0.95 explicit, 0.7 implied. Skip lower.

REASONING — include a "reasoning" field explaining why you picked these facts (or why you skipped). 1-2 sentences. This becomes a separate "decision" post so the audit trail explains the extraction.

Output strictly valid JSON:
{"facts":[{"predicate":"<verb>","object_text":"<value>","confidence":0.0-1.0},...],"summary":"<1 sentence>","reasoning":"<why these facts, 1-2 sentences>"}

If nothing genuinely new is extractable, output {"facts":[],"summary":"No new facts; data already known or signal too vague.","reasoning":"<why nothing new>"}`;

function buildUserPrompt(
  agentId: string,
  subName: string,
  subSemantic: string,
  signal: any,
  entity: { id: string; name: string; attributes: unknown },
  activeFacts: Array<{ id: string; predicate: string; object_text: string | null; confidence: number }>,
  pastOutcomesList: Array<{ entity_name: string; gate_policy: string; decision: string; decided_at: string; similarity: number | null }> = [],
  contacts: Array<{ name: string; email: string; role: string }> = [],
  matchedTheme: string | null = null,
  matchedEvidence: string | null = null,
): string {
  // Strip embedding from signal (massive vector adds nothing for the LLM and burns tokens).
  const { embedding: _e, ...signalForPrompt } = signal ?? {};

  const pastOutcomesBlock = pastOutcomesList.length
    ? `\nPAST OUTCOMES (recent gate decisions on this entity or semantically similar ones — pay attention to repeated patterns):\n${pastOutcomesList.map((o) => {
        const sim = o.similarity != null ? ` sim=${o.similarity.toFixed(2)}` : '';
        return `  ${o.decided_at.slice(0, 10)} ${o.entity_name}${sim}: ${o.decision} (policy=${o.gate_policy})`;
      }).join('\n')}\n`
    : '';

  const contactsBlock = contacts.length
    ? `\nCONTACTS (linked to this account — pick the best fit for the role you're targeting):\n${contacts.map((c) => `  ${c.name} <${c.email}>${c.role ? ` — ${c.role}` : ''}`).join('\n')}\n`
    : '';

  const angleBlock = matchedTheme
    ? `\nPRIMARY ANGLE (locked by upstream action_selector — your draft MUST lead with this):\n  theme: ${matchedTheme}\n  evidence: ${matchedEvidence ?? '(see active facts)'}\nDo not pivot to a different angle. The first paragraph of the body should reference this specific fact.\n`
    : '';

  return `AGENT: ${agentId}
FILTER RULE: "${subName}" — semantic intent: "${subSemantic}"

SIGNAL:
${JSON.stringify(signalForPrompt, null, 2)}

ACCOUNT: ${entity.name}
ATTRIBUTES (already known — do not re-extract these as facts):
${JSON.stringify(entity.attributes, null, 2)}

ACTIVE FACTS (already asserted — do not duplicate):
${activeFacts.length ? activeFacts.map((f) => `  ${f.id} | ${f.predicate}=${f.object_text} (conf=${f.confidence})`).join('\n') : '  (none yet)'}
${pastOutcomesBlock}${contactsBlock}${angleBlock}
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
  // Anti-pitch filler. Drafts that lean on these say nothing concrete and read like a templated AI tells.
  { re: /\bAI[- ]native CRM\b/gi, replace: '' },
  { re: /\bagent[- ]native (CRM|architecture|approach|platform|system)\b/gi, replace: '' },
  { re: /\boptimizes? (agent )?(workflows?|operations|processes?)\b/gi, replace: '' },
  { re: /\bbuilt (specifically )?for agents\b/gi, replace: '' },
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

async function gateAndPost(
  supabase: SupabaseClient,
  actor: { workspace_id: string; actor_kind: 'agent' | 'user' | 'system'; actor_id: string },
  channel_id: string,
  parent_event_id: string | undefined,
  body: string,
  cites: string[],
  policy: string,
  condition: Record<string, unknown>,
): Promise<{ ok: boolean; channel_post_id?: string; gate_id?: string; error?: string }> {
  const post = await callTool(supabase, actor, 'post_to_channel', {
    channel_id, kind: 'gate_request', body, cites,
  }, { parent_event_id });
  if (!post.ok) return { ok: false, error: post.error };
  const gate = await callTool(supabase, actor, 'request_gate', {
    channel_post_id: post.target_id, policy, condition,
  }, { parent_event_id });
  if (!gate.ok) return { ok: false, error: gate.error, channel_post_id: post.target_id };
  return { ok: true, channel_post_id: post.target_id, gate_id: gate.target_id };
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

  // 2. Negative-result cache. If a prior Hunter call on this entity returned
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
