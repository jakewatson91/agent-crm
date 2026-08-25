/**
 * Deep account qualification — the one adaptive multi-step loop in the system.
 *
 * Unlike the cheap single-shot enrich/score path and the fixed-fan-out research
 * path (researchRunner runs the same pre-planned Exa angles for every company),
 * this loop reasons step by step on ONE company: read what's known -> search ->
 * read the page that matters -> follow the relevant thread -> identify the buyer
 * -> decide the single best outreach angle -> record a sourced verdict. It is the
 * expensive, high-value path, so the autonomous trigger limits it to high-fit
 * accounts (see agent_logic.ts) — but the chat `qualify_account` tool runs it on
 * demand regardless.
 *
 * Built on the shared runner (runner.ts): the runner handles the loop, per-step
 * event logging, token accounting, and the step/token/empty-streak stop guards.
 * This module supplies the tools + prompts.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  callTool, runExaSearch, fetchPageText, getPolicy, resolveEnvVar, resolveQualification,
  chatCompleteForWorkspace,
} from '@agent-crm/tools';
import type { Actor } from '@agent-crm/primitives';
import { runAgentLoop, type LoopTool, type LoopToolCtx } from './runner.ts';

const QUALIFIER_AGENT = 'qualifier';

export interface RunQualificationParams {
  workspace_id: string;
  entity_id: string;
  /** Defaults to the 'qualifier' agent actor. The chat path can pass its own. */
  actor?: Actor;
}

export interface RunQualificationResult {
  ok: boolean;
  verdict?: string | null;
  recommended_angle?: string | null;
  steps?: number;
  total_tokens?: number;
  stopped_reason?: string;
  run_event_id?: string | null;
  error?: string;
}

export async function runQualification(
  supabase: SupabaseClient,
  params: RunQualificationParams,
): Promise<RunQualificationResult> {
  const { workspace_id, entity_id } = params;
  const actor: Actor = params.actor ?? { workspace_id, actor_kind: 'agent', actor_id: QUALIFIER_AGENT };

  const policy = await getPolicy(supabase, workspace_id);
  const cfg = resolveQualification(policy);
  const exaKey = resolveEnvVar(policy, 'EXA_API_KEY');
  const deepseekKey = resolveEnvVar(policy, 'DEEPSEEK_API_KEY', (p) => p.llm?.deepseek_api_key);

  const ent = await supabase.from('entities').select('id, name, attributes').eq('id', entity_id).maybeSingle();
  if (!ent.data) return { ok: false, error: `entity ${entity_id} not found` };
  const entityName = (ent.data.name as string) ?? '(unknown)';
  const domain = (((ent.data.attributes as { domain?: string } | null)?.domain) ?? '').trim().toLowerCase();

  // web_search + fetch_page are the heart of the loop; without an Exa key the loop
  // can only read its own DB, which isn't qualification. Fail clearly so the caller
  // (chat tool / Inngest) surfaces the missing key instead of producing a hollow run.
  if (!exaKey) return { ok: false, error: 'EXA_API_KEY not configured for this workspace' };

  const ws = await supabase.from('workspaces').select('about, constitution, persona, icp').eq('id', workspace_id).maybeSingle();
  const about = ((ws.data?.about as string) ?? '').trim();
  const constitution = ((ws.data?.constitution as string) ?? '').trim();
  const personaIcp = !about ? `Workspace persona: ${JSON.stringify(ws.data?.persona ?? {})}\nWorkspace ICP: ${JSON.stringify(ws.data?.icp ?? {})}` : '';

  const knownFacts = await loadActiveFacts(supabase, workspace_id, entity_id);

  const system = buildSystemPrompt(about || personaIcp, constitution, cfg.max_steps);
  const prompt = buildUserPrompt(entityName, domain, knownFacts);
  const tools = buildQualificationTools({ exaKey, actor, entity_id, entityName });

  const result = await runAgentLoop({
    supabase, workspace_id, actor,
    loop_name: 'qualification',
    system, prompt, tools,
    model: cfg.model,
    api_keys: { deepseek: deepseekKey ?? undefined },
    max_steps: cfg.max_steps,
    token_budget: cfg.token_budget,
    max_empty_steps: cfg.max_empty_steps,
    target: { kind: 'entity', id: entity_id },
  });

  // Read back the verdict the record_verdict tool wrote, for a structured return.
  let verdict = await latestFactValue(supabase, workspace_id, entity_id, 'qualification_verdict');

  // Fallback: the loop can stop (token budget / step cap) before the model calls
  // record_verdict — then there's no verdict, which defeats the run. Force one
  // from the facts gathered (including this run's), with a single cheap call. This
  // guarantees every run produces an auditable verdict regardless of how it ended.
  if (!verdict) {
    const gathered = await loadActiveFacts(supabase, workspace_id, entity_id);
    const forced = await forceVerdict(supabase, workspace_id, entityName, domain, gathered);
    if (forced) {
      await persistVerdict(supabase, actor, workspace_id, entity_id, entityName, result.run_event_id, forced);
      verdict = forced.verdict;
    }
  }
  const angle = await latestFactValue(supabase, workspace_id, entity_id, 'recommended_angle');

  return {
    ok: result.ok,
    verdict,
    recommended_angle: angle,
    steps: result.steps,
    total_tokens: result.total_tokens,
    stopped_reason: result.stopped_reason,
    run_event_id: result.run_event_id,
    error: result.error,
  };
}

// ---------------------------------------------------------------
// Tools — built per run so they close over the Exa key + subject entity.
// ---------------------------------------------------------------

interface BuildToolsOpts {
  exaKey: string;
  actor: Actor;
  entity_id: string;
  entityName: string;
}

export function buildQualificationTools(opts: BuildToolsOpts): Record<string, LoopTool> {
  const { exaKey, actor, entity_id, entityName } = opts;
  const meta = (ctx: LoopToolCtx) => ({ parent_event_id: ctx.run_event_id ?? undefined });

  const webSearch: LoopTool = {
    spec: {
      name: 'web_search',
      description: 'Search the web for current information about this company. Returns title, url, and a snippet for each hit. Use focused queries (a launch, a funding round, the team page). The company name is forced into results to avoid same-name collisions.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Focused search query.' },
          recency_days: { type: 'number', description: 'Optional: only results newer than this many days.' },
          num_results: { type: 'number', description: 'Default 5, max 8.' },
        },
        required: ['query'],
      },
    },
    run: async (_ctx, a: { query: string; recency_days?: number; num_results?: number }) => {
      const n = Math.min(Math.max(a.num_results ?? 5, 1), 8);
      const res = await runExaSearch(exaKey, {
        query: (a.query ?? '').slice(0, 300),
        num_results: n,
        text_chars: 1200,
        include_text: [entityName],
        start_published_date: a.recency_days ? new Date(Date.now() - a.recency_days * 86400_000).toISOString() : undefined,
      });
      if (!res.ok) return { error: res.error ?? 'search failed', results: [] };
      return {
        results: res.results.slice(0, n).map((r) => ({
          title: r.title, url: r.url, snippet: (r.text ?? '').slice(0, 500), published: r.publishedDate ?? null,
        })),
      };
    },
  };

  const fetchPage: LoopTool = {
    spec: {
      name: 'fetch_page',
      description: 'Fetch the readable text of one specific URL you found via web_search (a careers page, changelog, blog post, funding announcement). Use when a snippet looks relevant and you need the full page before deciding.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'The URL to read.' } },
        required: ['url'],
      },
    },
    run: async (_ctx, a: { url: string }) => {
      const res = await fetchPageText(exaKey, a.url, 4000);
      if (!res.ok) return { error: res.error ?? 'fetch failed' };
      return { url: res.url, title: res.title ?? null, text: res.text ?? '' };
    },
  };

  const readFacts: LoopTool = {
    spec: {
      name: 'read_facts',
      description: 'Read the facts already known about this company in the CRM (what prior runs found). Call this FIRST so you do not re-discover what is already known.',
      parameters: { type: 'object', properties: {} },
    },
    run: async (ctx) => ({ facts: await loadActiveFacts(ctx.supabase, ctx.workspace_id, entity_id) }),
  };

  const listContacts: LoopTool = {
    spec: {
      name: 'list_contacts',
      description: 'List people already linked to this company in the CRM (name, role, email if known). Read-only — it does NOT pull new contacts. If empty and the company qualifies, say so in your verdict and recommend pulling contacts; do not try to find emails yourself.',
      parameters: { type: 'object', properties: {} },
    },
    run: async (ctx) => ({ contacts: await loadLinkedContacts(ctx.supabase, ctx.workspace_id, entity_id) }),
  };

  const assertFact: LoopTool = {
    spec: {
      name: 'assert_fact',
      description: 'Record ONE atomic fact you confirmed from a page you actually read (e.g. predicate "raised_round", value "$5M seed, Jan 2026"). One predicate, one value, only what a source states. Idempotent. Assert facts as you discover them, before the final verdict.',
      parameters: {
        type: 'object',
        properties: {
          predicate: { type: 'string', description: 'snake_case relation, e.g. raised_round, launched_product, hiring_for.' },
          object_text: { type: 'string', description: 'The value.' },
          confidence: { type: 'number', description: '0-1. 0.9 explicit, 0.7 implied.' },
        },
        required: ['predicate', 'object_text'],
      },
    },
    run: async (ctx, a: { predicate: string; object_text: string; confidence?: number }) => {
      if (!a.predicate || !a.object_text) return { error: 'predicate and object_text required' };
      const conf = typeof a.confidence === 'number' ? Math.max(0, Math.min(1, a.confidence)) : 0.75;
      const r = await callTool(ctx.supabase, actor, 'assert_fact', {
        subject_entity: entity_id,
        predicate: a.predicate.toLowerCase().replace(/\s+/g, '_'),
        object_text: a.object_text,
        confidence: conf,
      }, meta(ctx));
      if (!r.ok) return { error: r.error };
      return { ok: true, created: r.created };
    },
  };

  const recordVerdict: LoopTool = {
    spec: {
      name: 'record_verdict',
      description: 'Call this EXACTLY ONCE as your final action. Records your qualification decision + the recommended outreach angle and ends the run. Do not assert facts after it.',
      parameters: {
        type: 'object',
        properties: {
          verdict: { type: 'string', enum: ['qualified', 'not_qualified', 'needs_more'] },
          confidence: { type: 'number', description: '0-1.' },
          buyer: { type: 'string', description: 'Likely buyer role/person, if qualified.' },
          recommended_angle: { type: 'string', description: 'The single best outreach angle, if qualified.' },
          rationale: { type: 'string', description: 'One short paragraph: why this verdict, citing what you found.' },
        },
        required: ['verdict', 'rationale'],
      },
    },
    run: async (ctx, a: VerdictInput) => {
      await persistVerdict(ctx.supabase, actor, ctx.workspace_id, entity_id, entityName, ctx.run_event_id, a);
      return { done: true, verdict: a.verdict };
    },
  };

  return { read_facts: readFacts, web_search: webSearch, fetch_page: fetchPage, list_contacts: listContacts, assert_fact: assertFact, record_verdict: recordVerdict };
}

// ---------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------

function buildSystemPrompt(aboutBlock: string, constitution: string, maxSteps: number): string {
  const fitBlock = aboutBlock
    ? `HOW THE COMPANY YOU WORK FOR SELLS (judge fit against THIS, not a generic notion of a good lead):\n${aboutBlock}`
    : 'You have no explicit description of what your company sells. Judge fit on general signs of a reachable, growing business with a current reason to talk.';
  const constitutionBlock = constitution ? `\n\nVOICE / RULES:\n${constitution}` : '';

  return `You are a sales qualification researcher for an agent-native CRM. Your job: decide whether ONE company is worth your operator reaching out to, find the likely buyer, and pick the single best outreach angle — using live web research.

${fitBlock}${constitutionBlock}

HOW TO WORK:
- You have a HARD budget of about ${maxSteps} steps. Spend the first few researching, then decide. Do not research forever.
- Each step: think briefly, then call ONE tool. (Calling two at once burns the budget twice as fast.)
- Start with read_facts (what's already known) and list_contacts (is there a buyer linked), so you don't repeat work.
- Then search/fetch only what's missing. Prefer fetch_page on a specific relevant URL over repeated broad searches.
- Record what you confirm with assert_fact as you go — one atomic fact each, only what a page actually states.
- If two tool calls in a row come back empty or error, STOP searching and record your verdict with what you have. Do not retry variations of the same query.

DECIDING:
- qualified: clear fit with how you sell AND a real, current reason to reach out now (a trigger: launch, raise, hire, product change). Name the buyer role and the one angle.
- needs_more: plausible fit but you could not confirm a trigger or a buyer within budget.
- not_qualified: off-fit, dead/dissolved, or no current reason to reach out.
- If no contact is linked but the company qualifies, still record "qualified" and note that contacts must be pulled before drafting.

FINISH: you MUST call record_verdict before the budget runs out — aim to call it by step ${Math.max(maxSteps - 1, 1)}. A run that ends with no verdict is a failure. When in doubt, record "needs_more" with what you have rather than searching more.`;
}

function buildUserPrompt(
  entityName: string,
  domain: string,
  facts: Array<{ fact: string; value: string | null }>,
): string {
  const factLines = facts.length
    ? facts.map((f) => `  - ${f.fact}: ${f.value ?? ''}`).join('\n')
    : '  (none yet)';
  return `COMPANY: ${entityName}${domain ? ` (${domain})` : ''}

KNOWN FACTS already in the CRM:
${factLines}

Qualify this company. Begin with read_facts and list_contacts.`;
}

// ---------------------------------------------------------------
// Shared DB helpers
// ---------------------------------------------------------------

/** Active facts = rows no other row supersedes; scores excluded (machine noise). */
async function loadActiveFacts(
  supabase: SupabaseClient,
  workspace_id: string,
  entity_id: string,
): Promise<Array<{ fact: string; value: string | null }>> {
  const r = await supabase
    .from('facts')
    .select('id, predicate, object_text, supersedes')
    .eq('workspace_id', workspace_id)
    .eq('subject_entity', entity_id);
  const rows = (r.data ?? []) as Array<{ id: string; predicate: string; object_text: string | null; supersedes: string | null }>;
  const superseded = new Set(rows.map((x) => x.supersedes).filter((x): x is string => !!x));
  return rows
    .filter((x) => !superseded.has(x.id) && !/^score_/.test(x.predicate))
    .slice(0, 60)
    .map((x) => ({ fact: x.predicate, value: x.object_text }));
}

async function loadLinkedContacts(
  supabase: SupabaseClient,
  workspace_id: string,
  entity_id: string,
): Promise<Array<{ name: string; role: string; email: string }>> {
  const links = await supabase
    .from('facts').select('subject_entity')
    .eq('workspace_id', workspace_id).eq('predicate', 'works_at').eq('object_entity', entity_id)
    .is('supersedes', null).limit(10);
  const ids = ((links.data ?? []) as Array<{ subject_entity: string }>).map((x) => x.subject_entity);
  if (!ids.length) return [];
  const [ents, roleF, emailF] = await Promise.all([
    supabase.from('entities').select('id, name').in('id', ids),
    supabase.from('facts').select('subject_entity, object_text').eq('predicate', 'role').in('subject_entity', ids).is('supersedes', null),
    supabase.from('facts').select('subject_entity, object_text').eq('predicate', 'email').in('subject_entity', ids).is('supersedes', null),
  ]);
  const nameById = new Map<string, string>();
  const roleById = new Map<string, string>();
  const emailById = new Map<string, string>();
  for (const e of (ents.data ?? []) as Array<{ id: string; name: string }>) nameById.set(e.id, e.name);
  for (const f of (roleF.data ?? []) as Array<{ subject_entity: string; object_text: string }>) roleById.set(f.subject_entity, f.object_text);
  for (const f of (emailF.data ?? []) as Array<{ subject_entity: string; object_text: string }>) emailById.set(f.subject_entity, f.object_text);
  return ids.map((id) => ({ name: nameById.get(id) ?? '(unknown)', role: roleById.get(id) ?? '', email: emailById.get(id) ?? '' }));
}

/** Current value of a single-valued fact (the row no other supersedes). */
async function latestFactValue(
  supabase: SupabaseClient,
  workspace_id: string,
  entity_id: string,
  predicate: string,
): Promise<string | null> {
  const r = await supabase
    .from('facts').select('id, object_text, supersedes')
    .eq('workspace_id', workspace_id).eq('subject_entity', entity_id).eq('predicate', predicate);
  const rows = (r.data ?? []) as Array<{ id: string; object_text: string | null; supersedes: string | null }>;
  if (!rows.length) return null;
  const superseded = new Set(rows.map((x) => x.supersedes).filter((x): x is string => !!x));
  const current = rows.find((x) => !superseded.has(x.id)) ?? rows[rows.length - 1];
  return current?.object_text ?? null;
}

interface VerdictInput {
  verdict: string;
  confidence?: number;
  buyer?: string;
  recommended_angle?: string;
  rationale: string;
}

/** Write the verdict (facts + a decision post). Shared by the record_verdict tool
 * and the post-loop fallback so both produce identical, auditable output. */
async function persistVerdict(
  supabase: SupabaseClient,
  actor: Actor,
  workspace_id: string,
  entity_id: string,
  entityName: string,
  runEventId: string | null,
  v: VerdictInput,
): Promise<void> {
  const conf = typeof v.confidence === 'number' ? Math.max(0, Math.min(1, v.confidence)) : 0.7;
  const meta = { parent_event_id: runEventId ?? undefined };
  await callTool(supabase, actor, 'assert_fact', { subject_entity: entity_id, predicate: 'qualification_verdict', object_text: v.verdict, confidence: conf }, meta);
  if (v.recommended_angle) await callTool(supabase, actor, 'assert_fact', { subject_entity: entity_id, predicate: 'recommended_angle', object_text: v.recommended_angle, confidence: conf }, meta);
  if (v.buyer) await callTool(supabase, actor, 'assert_fact', { subject_entity: entity_id, predicate: 'buyer_persona', object_text: v.buyer, confidence: conf }, meta);
  const channel_id = await ensureChannel(supabase, workspace_id, entity_id, entityName);
  if (channel_id) {
    const parts = [
      `Qualification: ${v.verdict} (${conf.toFixed(2)}).`,
      v.buyer ? `Buyer: ${v.buyer}.` : '',
      v.recommended_angle ? `Angle: ${v.recommended_angle}.` : '',
      v.rationale,
    ].filter(Boolean);
    await callTool(supabase, actor, 'post_to_channel', { channel_id, kind: 'decision', body: parts.join(' ') }, meta);
  }
}

/** One cheap single-shot call that turns the gathered facts into a verdict, used
 * only when the loop stopped before the model recorded one itself. Mirrors the
 * model choice of the other single-shot intake calls (Flash, policy-overridable). */
async function forceVerdict(
  supabase: SupabaseClient,
  workspace_id: string,
  entityName: string,
  domain: string,
  facts: Array<{ fact: string; value: string | null }>,
): Promise<VerdictInput | null> {
  const factLines = facts.length ? facts.map((f) => `- ${f.fact}: ${f.value ?? ''}`).join('\n') : '(none)';
  const sys = `You are wrapping up a sales qualification. Given the facts gathered about a company, output a final verdict as JSON. Be decisive.
Output exactly: {"verdict":"qualified"|"not_qualified"|"needs_more","confidence":0-1,"buyer":"<role or empty>","recommended_angle":"<one angle or empty>","rationale":"<one sentence>"}`;
  const user = `COMPANY: ${entityName}${domain ? ` (${domain})` : ''}
FACTS GATHERED:
${factLines}

Return the JSON verdict.`;
  try {
    const llm = await chatCompleteForWorkspace(supabase, workspace_id, {
      model: 'deepseek-v4-flash',
      behavior: 'qualification',
      max_tokens: 400,
      // A verdict, a confidence, a role, an angle and one sentence. The prompt
      // above already says "be decisive"; thinking here just bills for the
      // deliberation the prompt asked it to skip.
      thinking: 'disabled',
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
    });
    const p = JSON.parse(llm.text) as VerdictInput;
    return p?.verdict ? p : null;
  } catch {
    return null;
  }
}

/** Lazily create the entity's channel if missing — mirrors agent_logic.ts. */
async function ensureChannel(
  supabase: SupabaseClient,
  workspace_id: string,
  entity_id: string,
  name: string,
): Promise<string | null> {
  const chan = await supabase.from('channels').select('id')
    .eq('workspace_id', workspace_id).eq('account_entity_id', entity_id).maybeSingle();
  if (chan.data?.id) return chan.data.id as string;
  await supabase.from('channels').upsert(
    { workspace_id, account_entity_id: entity_id, title: name || 'Account' },
    { onConflict: 'workspace_id,account_entity_id', ignoreDuplicates: true },
  );
  const re = await supabase.from('channels').select('id')
    .eq('workspace_id', workspace_id).eq('account_entity_id', entity_id).maybeSingle();
  return (re.data?.id as string) ?? null;
}
