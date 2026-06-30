/**
 * Research strategy planner. Turns a workspace's own description + light human
 * guidance into a small set of AI-written search angles the deep-research path runs
 * per entity. The model authors the queries (it knows how it searches best); the
 * human only edits guidance / must-include terms / an on-off toggle per angle.
 *
 * Two entry points:
 *   - generateResearchStrategy : pure — builds the angles, no DB write. Used by the
 *     settings "regenerate" action and the About-save derive path.
 *   - ensureResearchStrategy   : cached — returns the persisted strategy if fresh,
 *     else generates + persists. Called once per workspace per dispatcher tick so the
 *     runner always finds a cached strategy (the runner never calls the LLM itself).
 *
 * Vertical-neutral: a fresh workspace with no About / guidance falls back to
 * BASELINE_ANGLES — universal company signals (own blog, news, customers), no brand
 * names, no vertical assumptions. The query CONTENTS are AI-generated or human-entered.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { chatComplete } from '@agent-crm/primitives';
import { getPolicy } from './policy.ts';
import { runExaSearch } from './exa_search.ts';
import type { ResearchAngle, WorkspacePolicy } from './policy.ts';

// Pro, not flash: the planner runs rarely (≈once per workspace per 14 days, or on a
// guidance change) but every search the agent makes flows from it — same reasoning that
// puts the drafter on pro. A few cents per regeneration buys much better angles.
const PLANNER_MODEL = 'deepseek-v4-pro';
const STRATEGY_STALE_DAYS = 14;
const DEFAULT_NUM_RESULTS = 4;

/**
 * Neutral fallback when there's nothing to plan from (empty About + guidance) or the
 * planner errors. Universal company signals every seller wants, none hiring-related
 * (the ATS connector owns hiring) and none aggregator-shaped.
 */
export const BASELINE_ANGLES: ResearchAngle[] = [
  {
    id: 'own_site_recent',
    label: 'Their own posts & launches',
    query_template: '{entity} blog OR launch OR announcement OR customer OR case study OR changelog OR product',
    domain_scope: 'own_site',
    recency_days: 365,
    num_results: 5,
  },
  {
    id: 'in_the_news',
    label: 'In the news',
    query_template: '{entity}',
    domain_scope: 'news',
    recency_days: 120,
    num_results: 5,
  },
  {
    id: 'who_they_sell_to',
    label: 'Who they sell to',
    query_template: '{entity} customers OR case study OR "trusted by" OR partners with',
    domain_scope: 'open_web',
    num_results: 4,
  },
];

const VALID_SCOPES = new Set(['own_site', 'news', 'open_web']);

function slugify(s: string, fallback: string): string {
  const out = s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return out || fallback;
}

/** Normalize / validate one raw angle from the model into a ResearchAngle, or null. */
function coerceAngle(raw: unknown, idx: number, usedIds: Set<string>): ResearchAngle | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const query_template = typeof r.query_template === 'string' ? r.query_template.trim() : '';
  // Must reference the entity or it's a global query, not an entity research angle.
  if (!query_template || !query_template.includes('{entity}')) return null;
  const scope = typeof r.domain_scope === 'string' ? r.domain_scope : '';
  if (!VALID_SCOPES.has(scope)) return null;
  let id = slugify(typeof r.id === 'string' ? r.id : '', `angle_${idx}`);
  while (usedIds.has(id)) id = `${id}_${idx}`;
  usedIds.add(id);
  const recency = typeof r.recency_days === 'number' && r.recency_days > 0 ? Math.round(r.recency_days) : undefined;
  const num = typeof r.num_results === 'number' && r.num_results > 0 ? Math.min(Math.round(r.num_results), 10) : DEFAULT_NUM_RESULTS;
  return {
    id,
    label: typeof r.label === 'string' && r.label.trim() ? r.label.trim().slice(0, 60) : id,
    query_template: query_template.slice(0, 200),
    domain_scope: scope as ResearchAngle['domain_scope'],
    recency_days: recency,
    num_results: num,
    enabled: true,
  };
}

export interface PlannerContext {
  about: string;
  icp?: string;
  value_props: string[];
  pain_points: string[];
  guidance: string;
  always_include: string[];
}

async function loadContext(supabase: SupabaseClient, workspace_id: string): Promise<{ ctx: PlannerContext; policy: WorkspacePolicy }> {
  const policy = await getPolicy(supabase, workspace_id);
  const w = await supabase.from('workspaces').select('about, icp').eq('id', workspace_id).maybeSingle();
  const icpObj = (w.data?.icp ?? {}) as Record<string, unknown>;
  const ctx: PlannerContext = {
    about: (w.data?.about as string | null)?.trim() ?? '',
    icp: typeof icpObj === 'object' ? JSON.stringify(icpObj).slice(0, 1500) : '',
    value_props: (policy.drafter?.value_props ?? []).filter(Boolean),
    pain_points: (policy.drafter?.pain_points ?? []).filter(Boolean),
    guidance: (policy.research?.guidance ?? '').trim(),
    always_include: (policy.research?.always_include ?? []).filter(Boolean),
  };
  return { ctx, policy };
}

const SYS_PROMPT = `You design a small set of WEB SEARCH ANGLES an AI sales agent runs, per prospect company, to find concrete outreach hooks: what the company shipped, who they sell to, what they wrote, recent moves. Each angle becomes one Exa web search per company.

Return 3 to 5 angles. Fewer, sharper angles beat many overlapping ones.

PRIORITIES (most valuable first):
1. The company's OWN site — recent blog posts, product launches, changelog, customer/case-study pages. ALWAYS include at least one "own_site" angle.
2. Who they sell to — customers, case studies, "trusted by", partnerships. Include one.
3. Recent third-party coverage of substance — a launch, partnership, or product story.
Funding rounds and investor names are LOW value on their own: include at most ONE angle that touches funding, never as the lead, and only with domain_scope "news".

Each angle has:
- "query_template": plain search keywords / OR-groups. MUST contain the literal token {entity} (the company name is substituted). You may use {domain}. Write it the way you'd phrase a web search to surface substantive pages. Do NOT use search-engine operators — no site:, -site:, filetype:, intitle:, or minus-exclusions. Domain include/exclude is handled by domain_scope, not the query text.
- "domain_scope": exactly one of:
    "own_site"  -> restricted to the company's own website (blog, launches, customers). Highest signal.
    "news"      -> press / news coverage about the company by others.
    "open_web"  -> the open web (third-party write-ups, customer lists, comparisons).
- "recency_days": set when freshness matters (news, launches: 90-180). For "own_site" angles prefer a generous window (365) or omit it — a company's own blog/product/customer pages are worth surfacing even if not brand-new. Omit for evergreen pages (customer lists, case studies).
- "id": short slug. "label": short human title. "num_results": 3-5.

Do NOT search for jobs/careers/hiring — a separate connector covers hiring. Avoid aggregator, profile, and directory pages (funding databases, professional-network company pages) — they restate what we already know and give no hook.

Tailor query terms to who THIS workspace sells to and the problems they solve (below). Every must-include term provided must be covered by at least one angle.

Return JSON only: {"angles":[{"id","label","query_template","domain_scope","recency_days","num_results"}]}`;

function buildUserPayload(ctx: PlannerContext): string {
  const parts: string[] = [];
  if (ctx.about) parts.push(`WORKSPACE (who they are / who they sell to):\n${ctx.about.slice(0, 2000)}`);
  if (ctx.icp && ctx.icp !== '{}') parts.push(`ICP (structured):\n${ctx.icp}`);
  if (ctx.value_props.length) parts.push(`What they offer:\n- ${ctx.value_props.slice(0, 8).join('\n- ')}`);
  if (ctx.pain_points.length) parts.push(`Problems they solve:\n- ${ctx.pain_points.slice(0, 8).join('\n- ')}`);
  if (ctx.guidance) parts.push(`OPERATOR GUIDANCE (what to dig up about prospects):\n${ctx.guidance.slice(0, 1500)}`);
  if (ctx.always_include.length) parts.push(`MUST-INCLUDE terms/topics (each covered by >=1 angle):\n- ${ctx.always_include.join('\n- ')}`);
  return parts.join('\n\n') || '(no workspace description provided — produce a neutral, universal set of company-signal angles)';
}

/**
 * Plan angles from an already-built context (no DB read). Used by the regenerate
 * endpoint, which builds context from freshly-derived About fields. Falls back to
 * BASELINE_ANGLES on any error or empty result.
 */
export async function planResearchAngles(
  ctx: PlannerContext,
  opts?: { model?: string },
): Promise<{ angles: ResearchAngle[]; source: 'ai' | 'baseline'; error?: string }> {
  // Nothing to plan from -> neutral baseline, no LLM spend.
  if (!ctx.about && !ctx.guidance && !ctx.always_include.length && !ctx.value_props.length) {
    return { angles: BASELINE_ANGLES, source: 'baseline' };
  }
  try {
    const llm = await chatComplete({
      model: opts?.model ?? PLANNER_MODEL,
      max_tokens: 1200,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYS_PROMPT },
        { role: 'user', content: buildUserPayload(ctx) },
      ],
    });
    const parsed = JSON.parse(llm.text) as { angles?: unknown[] };
    const usedIds = new Set<string>();
    const angles: ResearchAngle[] = [];
    for (const [i, raw] of (parsed.angles ?? []).entries()) {
      const a = coerceAngle(raw, i, usedIds);
      if (a) angles.push(a);
      if (angles.length >= 6) break;
    }
    if (!angles.length) return { angles: BASELINE_ANGLES, source: 'baseline', error: 'planner returned no valid angles' };
    return { angles, source: 'ai' };
  } catch (e) {
    return { angles: BASELINE_ANGLES, source: 'baseline', error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Build the angle set for a workspace from its persisted About/ICP/policy. Pure: no
 * DB write. Falls back to BASELINE_ANGLES on any error or empty result.
 */
export async function generateResearchStrategy(
  supabase: SupabaseClient,
  workspace_id: string,
  opts?: { model?: string },
): Promise<{ angles: ResearchAngle[]; source: 'ai' | 'baseline'; error?: string }> {
  let ctx: PlannerContext;
  try {
    ({ ctx } = await loadContext(supabase, workspace_id));
  } catch (e) {
    return { angles: BASELINE_ANGLES, source: 'baseline', error: e instanceof Error ? e.message : String(e) };
  }
  return planResearchAngles(ctx, opts);
}

const RELEVANCE_MODEL = 'deepseek-v4-flash';

function hostOf(url: string): string | null {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
}

/**
 * Fetch the company's own homepage/about text to use as disambiguation grounding.
 * Critical when the entity is thin (no descriptive facts) and the name is common — the
 * bare domain string alone ("usehatch.com") doesn't tell the gate what the company does,
 * so a more prominent same-name company can win. One cheap Exa call scoped to the domain.
 */
export async function fetchEntityGrounding(apiKey: string, name: string, domain: string): Promise<string> {
  if (!domain) return '';
  const r = await runExaSearch(apiKey, { query: name, num_results: 3, include_domains: [domain] });
  if (!r.ok) return '';
  // Exa's includeDomains can leak a loosely-related result; keep only pages actually on
  // the entity's own domain so the grounding describes the right company, not a same-name one.
  return r.results
    .filter((x) => { const h = hostOf(x.url); return !!h && (h === domain || h.endsWith(`.${domain}`)); })
    .map((x) => [x.title, (x.text ?? '').slice(0, 220)].filter(Boolean).join(' — '))
    .join(' | ')
    .slice(0, 500);
}

export interface RelevanceResult { accepted: Set<string>; checked: number; auto: number; dropped: number }

/**
 * Disambiguate open-web results against the target company so a same-name but unrelated
 * organization never becomes a signal (e.g. the SaaS "Hatch" at usehatch.com vs an
 * engineering firm also called Hatch doing lithium mining). Results served from the
 * company's own domain are auto-accepted; the rest pass one cheap LLM check grounded in
 * the company's domain + a short description. This is what makes the news / open_web
 * angles safe — only own_site is collision-proof by construction.
 */
export async function filterResultsByEntity(
  target: { name: string; domain: string; context: string },
  results: Array<{ id: string; title: string | null; url: string; text?: string }>,
  opts?: { model?: string },
): Promise<RelevanceResult> {
  const accepted = new Set<string>();
  const toCheck: typeof results = [];
  for (const r of results) {
    const host = hostOf(r.url);
    if (target.domain && host && (host === target.domain || host.endsWith(`.${target.domain}`))) accepted.add(r.id);
    else toCheck.push(r);
  }
  const auto = accepted.size;
  if (!toCheck.length) return { accepted, checked: 0, auto, dropped: 0 };

  const sys = `You verify whether a web page is about a SPECIFIC target company, or about a different organization that merely shares the name.

TARGET COMPANY:
- name: ${target.name}
- website: ${target.domain || '(unknown)'}
- about: ${target.context || '(little known — judge from the website domain and name)'}

A page is a MATCH only if it is about THIS company (the one at that website / fitting that description). A company in a different industry, sector, or country that happens to share the name is NOT a match. When genuinely unsure AND the page fits the target's description, lean toward matching.

Return JSON only: {"matches":["<id>", ...]} — the ids of pages about the target company.`;

  const payload = JSON.stringify(toCheck.map((r) => ({ id: r.id, title: r.title, url: r.url, text: (r.text ?? '').slice(0, 500) })));
  try {
    const llm = await chatComplete({
      model: opts?.model ?? RELEVANCE_MODEL,
      max_tokens: 800,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: sys }, { role: 'user', content: payload }],
    });
    const parsed = JSON.parse(llm.text) as { matches?: string[] };
    const matchSet = new Set((parsed.matches ?? []).map(String));
    let kept = 0;
    for (const r of toCheck) if (matchSet.has(r.id)) { accepted.add(r.id); kept++; }
    return { accepted, checked: toCheck.length, auto, dropped: toCheck.length - kept };
  } catch {
    // Fail-open: a transient LLM error shouldn't starve research. Rare; downstream
    // scoring still dampens any collision that slips through on that run.
    for (const r of toCheck) accepted.add(r.id);
    return { accepted, checked: toCheck.length, auto, dropped: 0 };
  }
}

/** Read the cached strategy off policy, filtered to enabled angles. Baseline if empty. */
export function resolveStrategy(policy: WorkspacePolicy): ResearchAngle[] {
  const stored = policy.research?.strategy ?? [];
  const enabled = stored.filter((a) => a.enabled !== false && a.query_template?.includes('{entity}') && VALID_SCOPES.has(a.domain_scope));
  return enabled.length ? enabled : BASELINE_ANGLES;
}

function isStrategyFresh(policy: WorkspacePolicy): boolean {
  const at = policy.research?.strategy_generated_at;
  const hasAngles = (policy.research?.strategy ?? []).length > 0;
  if (!hasAngles || !at) return false;
  const ageDays = (Date.now() - Date.parse(at)) / 86400000;
  return Number.isFinite(ageDays) && ageDays < STRATEGY_STALE_DAYS;
}

/** Merge an angle set onto workspaces.policy.research.strategy (cache write, not user config). */
export async function persistResearchStrategy(
  supabase: SupabaseClient,
  workspace_id: string,
  angles: ResearchAngle[],
): Promise<void> {
  const r = await supabase.from('workspaces').select('policy').eq('id', workspace_id).maybeSingle();
  const policy = (r.data?.policy ?? {}) as WorkspacePolicy;
  const next = {
    ...policy,
    research: {
      ...(policy.research ?? {}),
      strategy: angles,
      strategy_generated_at: new Date().toISOString(),
    },
  };
  await supabase.from('workspaces').update({ policy: next }).eq('id', workspace_id);
}

/**
 * Return a usable strategy, regenerating + persisting if the cached one is missing or
 * stale. Called by the dispatcher once per workspace per tick.
 */
export async function ensureResearchStrategy(supabase: SupabaseClient, workspace_id: string): Promise<ResearchAngle[]> {
  const policy = await getPolicy(supabase, workspace_id);
  if (isStrategyFresh(policy)) return resolveStrategy(policy);
  const { angles } = await generateResearchStrategy(supabase, workspace_id);
  try {
    await persistResearchStrategy(supabase, workspace_id, angles);
  } catch {
    // cache write failed — still return the freshly generated angles for this tick
  }
  return angles;
}
