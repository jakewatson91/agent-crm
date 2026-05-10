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
import { callTool } from '@agent-crm/tools';
import { chatComplete } from '@agent-crm/primitives';
import { createHash } from 'node:crypto';

const DEFAULT_MODEL = 'gpt-4o-mini';

type AgentBehavior = 'claim_poster' | 'drafter' | 'enricher';

export interface AgentRunPayload {
  workspace_id: string;
  agent: string;
  subscription_id?: string;
  signal_id?: string;
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

interface WorkspacePolicy {
  suppression_list?: string[];
  daily_send_cap?: number;
  notify_channels?: string[];
}

export async function runAgent(
  supabase: SupabaseClient,
  payload: AgentRunPayload,
): Promise<AgentRunResult> {
  if (!payload.signal_id) return { ok: false, action: 'skip', reason: 'no signal_id (v0 only handles signal-triggered runs)' };

  // 1. Signal + entity.
  const sig = await supabase
    .from('signals')
    .select('id, entity_id, type, magnitude, body_for_embedding, observed_at, structured_tags')
    .eq('id', payload.signal_id).single();
  if (sig.error || !sig.data) return { ok: false, action: 'skip', reason: `signal ${payload.signal_id} not found` };

  const ent = await supabase
    .from('entities').select('id, name, attributes')
    .eq('id', sig.data.entity_id).single();
  if (ent.error || !ent.data) return { ok: false, action: 'skip', reason: `entity ${sig.data.entity_id} not found` };

  // 2. Active facts.
  const allFacts = await supabase
    .from('facts')
    .select('id, predicate, object_text, confidence, supersedes')
    .eq('subject_entity', ent.data.id);
  if (allFacts.error) return { ok: false, action: 'skip', reason: `facts query failed: ${allFacts.error.message}` };
  const factRows = (allFacts.data ?? []) as Array<{ id: string; predicate: string; object_text: string | null; confidence: number; supersedes: string | null }>;
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

  // 5. Channel.
  const chan = await supabase
    .from('channels').select('id')
    .eq('workspace_id', payload.workspace_id).eq('account_entity_id', ent.data.id).maybeSingle();
  if (chan.error || !chan.data) return { ok: false, action: 'skip', reason: 'no channel for entity' };
  const channel_id = chan.data.id as string;

  const actor = { workspace_id: payload.workspace_id, actor_kind: 'agent' as const, actor_id: payload.agent };

  // ============================================================
  // Drafter pre-LLM deterministic checks
  // ============================================================
  if (behavior === 'drafter') {
    const suppression = policy.suppression_list ?? [];
    const entityDomain = ((ent.data.attributes as { domain?: string } | null)?.domain ?? '').toLowerCase();
    const entityName = (ent.data.name as string).toLowerCase();
    const suppressed = suppression.some((s) => {
      const t = s.toLowerCase();
      return entityDomain.includes(t) || entityName.includes(t) || ent.data.id === s;
    });
    if (suppressed) {
      const r = await gateAndPost(supabase, actor, channel_id, payload.parent_event_id,
        `Drafter blocked: ${ent.data.name} matches the suppression list. No outbound generated.`,
        [], 'suppression_match', { entity: ent.data.name, domain: entityDomain });
      return { ok: r.ok, action: 'request_gate', channel_post_id: r.channel_post_id, gate_id: r.gate_id, reason: r.error, behavior };
    }

    // Draft suppression: if a touch_draft already exists in this channel within the
    // suppression window, skip drafting. Re-drafting on every signal pile-ups multiple
    // drafts on one account (audit found 4 drafts on Ventura). Default 7d window.
    const draftSuppressionDays = (policy as { draft_suppression_days?: number }).draft_suppression_days ?? 7;
    if (draftSuppressionDays > 0) {
      const since = new Date(Date.now() - draftSuppressionDays * 86400 * 1000).toISOString();
      const existing = await supabase
        .from('channel_posts')
        .select('id, author_id, created_at')
        .eq('channel_id', channel_id)
        .eq('kind', 'touch_draft')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(1);
      if ((existing.data?.length ?? 0) > 0) {
        const last = existing.data![0]!;
        const ageDays = Math.round((Date.now() - Date.parse(last.created_at as string)) / 86400000 * 10) / 10;
        const r = await gateAndPost(supabase, actor, channel_id, payload.parent_event_id,
          `Drafter skipped: ${ent.data.name} already has a touch_draft from ${ageDays}d ago by ${last.author_id}. Approve or reject that one before drafting again.`,
          [], 'draft_already_exists', { entity: ent.data.name, existing_post_id: last.id, existing_author: last.author_id, age_days: ageDays });
        return { ok: r.ok, action: 'request_gate', channel_post_id: r.channel_post_id, gate_id: r.gate_id, reason: r.error, behavior };
      }
    }

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
        const r = await gateAndPost(supabase, actor, channel_id, payload.parent_event_id,
          `Drafter blocked: daily send cap reached (${usedToday}/${cap}). Try again tomorrow.`,
          [], 'rate_limit_exceeded', { used_today: usedToday, cap });
        return { ok: r.ok, action: 'request_gate', channel_post_id: r.channel_post_id, gate_id: r.gate_id, reason: r.error, behavior };
      }
    }
  }

  // ============================================================
  // Cache-friendly prompt structure:
  //   System message = stable across runs in this (workspace, behavior). Caches.
  //   User message   = per-run variable content (agent identity, signal, facts).
  // ============================================================
  const systemPrompt = buildSystemPrompt(behavior, about, constitution, ws.data.persona, ws.data.icp);
  const userPrompt = buildUserPrompt(payload.agent, subName, subSemantic, sig.data, ent.data, activeFacts);

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

  // ============================================================
  // Dispatch
  // ============================================================
  if (decision.action === 'post_claim' && behavior === 'claim_poster') {
    const r = await callTool(supabase, actor, 'post_to_channel', {
      channel_id, kind: 'claim', body: sanitizeText(decision.body ?? ''), cites: validCites,
    }, meta);
    if (!r.ok) return { ok: false, action: 'skip', reason: r.error, behavior, ...tokens };
    return { ok: true, action: 'post_claim', channel_post_id: r.target_id, behavior, ...tokens };
  }

  if (decision.action === 'post_touch_draft' && behavior === 'drafter') {
    const subject = sanitizeText((decision.subject as string) ?? '');
    const body = sanitizeText((decision.body as string) ?? '');
    const composed = subject ? `Subject: ${subject}\n\n${body}` : body;
    const r = await callTool(supabase, actor, 'post_to_channel', {
      channel_id, kind: 'touch_draft', body: composed, cites: validCites,
    }, meta);
    if (!r.ok) return { ok: false, action: 'skip', reason: r.error, behavior, ...tokens };
    // Auditable decision post explaining why we drafted. Cites the same facts so the
    // provenance walk works from either the draft or the decision.
    const reasoning = sanitizeText(((decision as { reasoning?: string }).reasoning ?? '').toString());
    if (reasoning) {
      await callTool(supabase, actor, 'post_to_channel', {
        channel_id, kind: 'decision', body: reasoning, cites: validCites, parent_post_id: r.target_id,
      }, meta);
    }
    return { ok: true, action: 'post_touch_draft', channel_post_id: r.target_id, behavior, ...tokens };
  }

  if (decision.action === 'request_gate') {
    const r = await gateAndPost(supabase, actor, channel_id, payload.parent_event_id,
      sanitizeText(decision.body ?? ''), validCites, decision.policy ?? 'low_confidence',
      decision.condition ?? { reason: 'agent flagged for review' });
    return { ok: r.ok, action: 'request_gate', channel_post_id: r.channel_post_id, gate_id: r.gate_id, reason: r.error, behavior, ...tokens };
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
    const summary = sanitizeText((decision.summary as string) ?? `Extracted ${asserted} fact${asserted === 1 ? '' : 's'}.`);
    const post = await callTool(supabase, actor, 'post_to_channel', {
      channel_id, kind: 'claim', body: summary, cites: assertedIds,
    }, meta);
    // Auditable decision post explaining the extraction reasoning.
    const reasoning = sanitizeText(((decision as { reasoning?: string }).reasoning ?? '').toString());
    if (reasoning && post.ok) {
      await callTool(supabase, actor, 'post_to_channel', {
        channel_id, kind: 'decision', body: reasoning, cites: assertedIds, parent_post_id: post.target_id,
      }, meta);
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

  return `${identity}${aboutBlock}${constitutionBlock}\n\n${decisionBlock}`;
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
   - Running GTM with 1-2 people + agents on top of HubSpot/Salesforce — bolt-on systems built for humans, retrofitted for AI
   - Token bloat: agents reading raw row dumps from legacy CRMs eat 5-10x the tokens they need to
   - Last-write-wins on shared accounts: when multiple agents update the same row, data silently disappears
   - No provenance: agents make claims your customer can't verify because there's no source-event chain
   Tie the problem to a specific fact about THIS account if you can (small team, recent fundraise, AI-forward stack).

4. ONE-LINER on what we do + why we're different — exactly 1 sentence. Pull the angle from the workspace ABOUT. Pick one of: agent-native architecture (events + facts, not rows), cost (sized for agents, not humans), event-mediated agent collaboration (no shared mutable state), surfacing info only when needed (gates, not dashboards). Pick the angle that connects to the problem statement above.

5. ASK — short. "Worth exploring?" or "Open to a 15-min chat?" or "Want to see it run?". One sentence.

Total: subject is one word; body covers parts 2-5 in order. Single paragraph or split into a few — your call based on what reads naturally. No transitional fluff between parts.

Voice and hard rules come from the workspace constitution above. Constitution wins over this formula on tone — if the constitution says "no em dashes" or "no jargon," follow that strictly even if the formula's example uses them.

GATE vs DRAFT decision — use these rules in order:
1. Are there ≥3 specific facts in the ACTIVE FACTS list (customer references, partnerships, funding events, product details, market positioning, hiring activity, technology stack)? If yes, draft — even if the saved filter rule's keyword intent isn't perfectly met.
2. Is the signal genuinely off-ICP (clearly not the kind of company the workspace ABOUT describes targeting)? If yes, gate with policy="off_icp".
3. Are the facts so thin you'd be writing generic copy with nothing concrete to reference? If yes, gate with policy="thin_facts".

CRITICAL: do NOT gate just because a single attribute (like is_hiring=false) doesn't match a literal word in your filter rule. The filter is a PRIORITIZATION SIGNAL for which signals to react to, not a hard constraint on which prospects deserve a draft. If a healthcare company has 4 named hospital customers and a partnership and the workspace sells to AI-forward operators, that's a draft, not a gate — even if the company isn't currently hiring.

REASONING — every post_touch_draft output MUST include a "reasoning" field: 1-2 sentences explaining why you drafted (which 2-3 facts you anchored to, what made this account a fit). This becomes a separate "decision" post in the channel so the human auditor (and future you) can see why each draft happened.

Output strictly valid JSON, no preamble:
{"action":"post_touch_draft","subject":"<one word>","body":"<email body, 4 short paragraphs separated by blank lines>","cites":["<fact_id_uuid>",...],"reasoning":"<why I drafted, 1-2 sentences>"}
OR
{"action":"request_gate","body":"<reason draft was not generated>","cites":[],"policy":"<short policy id>","condition":{<context>}}`;

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
): string {
  // Strip embedding from signal (massive vector adds nothing for the LLM and burns tokens).
  const { embedding: _e, ...signalForPrompt } = signal ?? {};
  return `AGENT: ${agentId}
FILTER RULE: "${subName}" — semantic intent: "${subSemantic}"

SIGNAL:
${JSON.stringify(signalForPrompt, null, 2)}

ACCOUNT: ${entity.name}
ATTRIBUTES (already known — do not re-extract these as facts):
${JSON.stringify(entity.attributes, null, 2)}

ACTIVE FACTS (already asserted — do not duplicate):
${activeFacts.length ? activeFacts.map((f) => `  ${f.id} | ${f.predicate}=${f.object_text} (conf=${f.confidence})`).join('\n') : '  (none yet)'}

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
];

/** Strip em/en dashes, tidy spacing, and excise corporate-template phrases the
 *  constitution forbids. Sanitize is the last gate before output. */
function sanitizeText(s: string): string {
  let out = s
    .replace(/\s*—\s*/g, ', ')
    .replace(/\s*–\s*/g, ', ');
  for (const { re, replace } of BANNED_PHRASES) {
    out = out.replace(re, replace);
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
