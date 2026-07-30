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
import { chatComplete, embed } from '@agent-crm/primitives';
import { getPolicy } from './policy.ts';
import { runExaSearch } from './exa_search.ts';
import { cosine } from './icp_embeddings.ts';
import type { ResearchAngle, WorkspacePolicy } from './policy.ts';

// Pro, not flash: the planner runs rarely (≈once per workspace per 14 days, or on a
// guidance change) but every search the agent makes flows from it — same reasoning that
// puts the drafter on pro. A few cents per regeneration buys much better angles.
const PLANNER_MODEL = 'deepseek-v4-pro';
const STRATEGY_STALE_DAYS = 14;
// Each fetched result costs a contents-text page on top of the search itself,
// so the default stays lean; angles that need more set num_results explicitly.
const DEFAULT_NUM_RESULTS = 3;

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
    recency_days: 30,
    num_results: 5,
  },
  {
    id: 'in_the_news',
    label: 'In the news',
    query_template: '{entity}',
    domain_scope: 'news',
    recency_days: 30,
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

const VALID_SCOPES = new Set(['own_site', 'news', 'open_web', 'social']);

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
  // policy.research.social_domains. Non-empty unlocks the `social` scope in the
  // planner prompt; empty keeps the scope out of the prompt entirely so the
  // model never plans angles the runner would skip.
  social_domains?: string[];
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
    social_domains: (policy.research?.social_domains ?? []).filter(Boolean),
  };
  return { ctx, policy };
}

const SYS_PROMPT = `You design a small set of WEB SEARCH ANGLES an AI sales agent runs, per prospect company, to find concrete outreach hooks: what the company shipped, who they sell to, what they wrote, recent moves. Each angle becomes one Exa web search per company.

Return 3 to 5 angles. Fewer, sharper angles beat many overlapping ones.

PRIORITIES (most valuable first):
1. What CHANGED or what they're pushing toward — launches, expansions, deals, published numbers, stated priorities and plans, executives explaining what the company is working on. These are the anchors a message can open with. Every angle should be able to surface something that HAPPENED or something the company SAYS it is doing next.
2. The company's OWN site — recent blog posts, product launches, changelog, customer/case-study pages. ALWAYS include at least one "own_site" angle.
3. Who they sell to — customers, case studies, "trusted by", partnerships. Include one.
Funding rounds and investor names are LOW value on their own: include at most ONE angle that touches funding, never as the lead, and only with domain_scope "news".

NEAR-WORTHLESS, never plan an angle toward it: pages that merely confirm the company matches a target profile — its industry, category, size, or what kind of business it is. The agent already knows who fits. A search that returns "yes, they are indeed that kind of company" gives a message nothing to anchor on.

Each angle has:
- "query_template": plain search keywords / OR-groups. MUST contain the literal token {entity} (the company name is substituted). You may use {domain}. Write it the way you'd phrase a web search to surface substantive pages. Do NOT use search-engine operators — no site:, -site:, filetype:, intitle:, or minus-exclusions. Domain include/exclude is handled by domain_scope, not the query text.
- "domain_scope": exactly one of:
    "own_site"  -> restricted to the company's own website (blog, launches, customers). Highest signal.
    "news"      -> press / news coverage about the company by others.
    "open_web"  -> the open web (third-party write-ups, customer lists, comparisons).
- "recency_days": a hard freshness floor — any dated result older than this (or older than 30 days if omitted on a non-evergreen angle) is dropped, regardless of domain_scope. Set it to 30 for news, launches, and "own_site" angles that target recent posts. Omit ONLY for a deliberately evergreen "own_site" angle (customer lists, general product pages) — an omitted value exempts UNDATED results from the floor, but a dated result on that same angle is still held to 30 days.
- "id": short slug. "label": short human title. "num_results": 3-5.

Do NOT search for jobs/careers/hiring — a separate connector covers hiring. Avoid aggregator, profile, and directory pages (funding databases, professional-network company pages) — they restate what we already know and give no hook.

Tailor query terms to who THIS workspace sells to and the problems they solve (below). Every must-include term provided must be covered by at least one angle.

Return JSON only: {"angles":[{"id","label","query_template","domain_scope","recency_days","num_results"}]}`;

// Appended to SYS_PROMPT only when the workspace configured
// policy.research.social_domains — otherwise the model never sees the scope and
// can't plan angles the runner would skip.
function socialScopeAddendum(domains: string[]): string {
  return `ADDITIONAL SCOPE available for this workspace:
    "social"    -> restricted to: ${domains.join(', ')}. Posts, talks, and interviews BY the prospect company's founders and executives — the concrete trigger a first-touch message can reference ("saw your post on X"). Include exactly ONE social angle. Phrase its query_template to surface a person speaking (post, talk, interview, panel, announcement by {entity} leadership), NOT the company's profile page. This is the one exception to the profile/directory-page rule above. Exec posts go stale fast: set recency_days 30.`;
}

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
        {
          role: 'system',
          content: ctx.social_domains?.length
            ? `${SYS_PROMPT}\n\n${socialScopeAddendum(ctx.social_domains)}`
            : SYS_PROMPT,
        },
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

/**
 * What kind of hook an accepted page carries, judged in the same LLM pass as
 * relevance. Drives signal magnitude so profile-confirmation pages ("yes, they
 * are that kind of company") stop ranking beside real triggers:
 *   event     — something dated happened (launch, deal, number, exec statement)
 *   direction — evidence of a current priority or push, no single dated event
 *   profile   — describes what the company is/does; confirms fit, nothing new
 * Pages accepted without the LLM pass (own-domain auto-accept, error fallback)
 * have no class and keep full magnitude.
 */
export type HookClass = 'event' | 'direction' | 'profile';

export interface RelevanceResult {
  accepted: Set<string>;
  classById: Map<string, HookClass>;
  checked: number;
  auto: number;
  dropped: number;
  /**
   * Which test each dropped page failed, so a collapse in research yield can be
   * read off the event log instead of reconstructed from config. This gate
   * discards the majority of everything research finds, and until now it
   * recorded a single total — diagnosing an 8x yield drop meant guessing which
   * of the three conditions had moved. `unreported` covers a model that skipped
   * the rejects list, and the error fallback.
   */
  droppedBy: { identity: number; substance: number; relevance: number; unreported: number };
}

/**
 * Disambiguate open-web results against the target company so a same-name but unrelated
 * organization never becomes a signal (e.g. the SaaS "Hatch" at usehatch.com vs an
 * engineering firm also called Hatch doing lithium mining). Results served from the
 * company's own domain are auto-accepted; the rest pass one cheap LLM check grounded in
 * the company's domain + a short description. This is what makes the news / open_web
 * angles safe — only own_site is collision-proof by construction.
 */
export interface RelevanceTarget {
  name: string;
  domain: string;
  context: string;
  // What this workspace sells / the pain it solves / what to dig for. Optional:
  // when empty, the check falls back to identity + substance only, so a fresh
  // workspace with no configured value prop is never over-filtered. When present,
  // it adds a third test that drops on-company but off-topic pages (a storage-vendor
  // deal for a CDN-cost product) before they ever become a signal.
  relevance?: { pains?: string[]; signal_types?: string[]; guidance?: string };
}

export async function filterResultsByEntity(
  target: RelevanceTarget,
  results: Array<{ id: string; title: string | null; url: string; text?: string }>,
  opts?: { model?: string },
): Promise<RelevanceResult> {
  // Relevance config decides how own-domain results are handled below, so compute it up
  // front. Only set when the workspace has said what it sells; empty = identity + substance
  // only, so a fresh workspace is never over-filtered.
  const pains = (target.relevance?.pains ?? []).filter(Boolean);
  const signalTypes = (target.relevance?.signal_types ?? []).filter(Boolean);
  const relGuidance = (target.relevance?.guidance ?? '').trim();
  const hasRelevance = pains.length > 0 || signalTypes.length > 0 || relGuidance.length > 0;

  const accepted = new Set<string>();
  const classById = new Map<string, HookClass>();
  const toCheck: Array<{ r: (typeof results)[number]; own: boolean }> = [];
  for (const r of results) {
    const host = hostOf(r.url);
    const onOwnDomain = !!target.domain && !!host && (host === target.domain || host.endsWith(`.${target.domain}`));
    // On their own domain → identity is proven. With no relevance config that's a full
    // accept (unchanged behavior). With relevance config it still must clear the relevance
    // bar — being on nhl.com does not make a storage-vendor press release relevant to a
    // CDN-cost seller — so it goes to the check with identity pre-confirmed (own=true).
    if (onOwnDomain && !hasRelevance) accepted.add(r.id);
    else toCheck.push({ r, own: onOwnDomain });
  }
  const auto = accepted.size;
  if (!toCheck.length) return { accepted, classById, checked: 0, auto, dropped: 0, droppedBy: { identity: 0, substance: 0, relevance: 0, unreported: 0 } };

  // With real grounding (own-site snippets / descriptive facts) an unsure-but-fitting
  // page is probably right, so lean toward matching. With nothing to test against,
  // "fits the description" is untestable — a generic same-name landing page would pass
  // by default — so the bias flips to rejecting anything unverifiable.
  const hasContext = target.context.trim().length >= 40;
  const unsureRule = hasContext
    ? 'When genuinely unsure AND the page clearly fits the target\'s description, lean toward matching.'
    : 'Almost nothing is known about the target, so identity cannot be confirmed from a description. Only match a page that explicitly references the target\'s website domain or is unmistakably the same organization. When unsure, do NOT match.';

  // Third condition (optional). Present only when the workspace configured what it sells /
  // what pain it solves. This is what stops an on-company but off-topic page — the exact
  // NHL/VAST storage press that scored 0.4 signal_strength — from becoming a signal on a
  // CDN-cost seller, whether the page is on their own site or in the news.
  const relevanceCondition = hasRelevance
    ? `\n3. It carries a signal RELEVANT to what this seller offers. The seller${pains.length ? ` helps companies with: ${pains.join('; ')}.` : ''}${signalTypes.length ? ` They watch for these triggers: ${signalTypes.join('; ')}.` : ''}${relGuidance ? ` What to dig for: ${relGuidance}` : ''}
   A page is relevant if its content plausibly connects to that problem area — the company growing or scaling in a way that drives it, a person there discussing it, a change that creates or reveals the need, or how the company runs the systems involved. A page about the right company but a clearly unrelated topic (a different part of the business with no bearing on that problem) is NOT relevant. Judge the connection by meaning, not keywords: "expanding to new regions" or "scaling to more users" counts even when none of the exact terms above appear.`
    : '';
  const passClause = hasRelevance ? 'all three tests' : 'both tests';

  const sys = `You verify whether a web page is (a) about a SPECIFIC target company, (b) substantive enough to be worth reading${hasRelevance ? ', and (c) relevant to what a specific seller offers' : ''}.

TARGET COMPANY:
- name: ${target.name}
- website: ${target.domain || '(unknown)'}
- about: ${target.context || '(nothing known)'}

A page is a MATCH only if ${hasRelevance ? 'ALL THREE' : 'BOTH'} hold:
1. It is about THIS company (the one at that website / fitting that description). A company in a different industry, sector, or country that happens to share the name is NOT a match. A page hosted on the target's own website is by definition this company — treat condition 1 as satisfied for it and judge it on the remaining conditions only. NOT a match: a page whose actual subject is a DIFFERENT company — a vendor's case study, press release, or write-up about that other company's project — where the target is merely named in passing as one of that company's customers, channels, brands, or products. The company the page is describing and solving problems FOR must BE the target, not a third party the target happens to be mentioned under. ${unsureRule}
2. It carries substantive content: news, a launch, a blog post, a case study, an interview, a partnership, a review with real detail. Directory listings, tool aggregators, company-profile pages, and databases that merely restate name + category + description are NOT a match even when they're about the right company — they contain nothing we don't already know.${relevanceCondition}

For each matching page, also classify what kind of hook it carries:
- "event": something dated HAPPENED — a launch, expansion, deal, published number, hire, or a person there saying something tied to a moment (a post, talk, interview).
- "direction": evidence of a current priority or push — what the company keeps working toward or says it is doing next, without one dated event.
- "profile": describes what the company is or does — confirms it fits a market but reports nothing new happening. These are the least valuable; be honest when a page is only this.

Return JSON only:
{"matches":[{"id":"<id>","class":"event"|"direction"|"profile"}, ...],
 "rejects":[{"id":"<id>","failed":"identity"|"substance"${hasRelevance ? '|"relevance"' : ''}}, ...]}

"matches" holds one entry per page that passes ${passClause}. "rejects" holds every other page, naming the FIRST test it failed — "identity" for test 1, "substance" for test 2${hasRelevance ? ', "relevance" for test 3' : ''}. Every page you were given must appear in exactly one of the two lists.`;

  const payload = JSON.stringify(toCheck.map(({ r }) => ({ id: r.id, title: r.title, url: r.url, text: (r.text ?? '').slice(0, 500) })));
  try {
    const llm = await chatComplete({
      model: opts?.model ?? RELEVANCE_MODEL,
      // Room for the rejects list too. A truncated response is unparseable JSON,
      // which falls through to the catch and drops every off-domain result — far
      // more costly than the extra output tokens.
      max_tokens: 1200,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: sys }, { role: 'user', content: payload }],
    });
    const parsed = JSON.parse(llm.text) as {
      matches?: Array<string | { id?: string; class?: string }>;
      rejects?: Array<{ id?: string; failed?: string }>;
    };
    const matchSet = new Set<string>();
    for (const m of parsed.matches ?? []) {
      // Tolerate the old bare-string shape (a cached model / retry could emit it).
      if (typeof m === 'string') { matchSet.add(m); continue; }
      if (!m?.id) continue;
      matchSet.add(String(m.id));
      if (m.class === 'event' || m.class === 'direction' || m.class === 'profile') classById.set(String(m.id), m.class);
    }
    let kept = 0;
    for (const { r } of toCheck) if (matchSet.has(r.id)) { accepted.add(r.id); kept++; }

    const droppedBy = { identity: 0, substance: 0, relevance: 0, unreported: 0 };
    const reasonById = new Map<string, string>();
    for (const rj of parsed.rejects ?? []) if (rj?.id) reasonById.set(String(rj.id), String(rj.failed ?? ''));
    for (const { r } of toCheck) {
      if (matchSet.has(r.id)) continue;
      const reason = reasonById.get(r.id);
      if (reason === 'identity' || reason === 'substance' || reason === 'relevance') droppedBy[reason] += 1;
      else droppedBy.unreported += 1;
    }
    return { accepted, classById, checked: toCheck.length, auto, dropped: toCheck.length - kept, droppedBy };
  } catch {
    // Fail: keep identity-confirmed own-domain results (only their relevance was in
    // question, and losing real own-site context is worse than one off-topic page), but
    // drop unverified off-domain results — a same-name company's news polluting the entity
    // is worse than one thin pass (the dispatcher re-runs on cadence anyway).
    let keptOnErr = 0;
    for (const { r, own } of toCheck) if (own) { accepted.add(r.id); keptOnErr++; }
    const dropped = toCheck.length - keptOnErr;
    // The gate never ran, so no page failed a named test. Counting these as
    // `unreported` keeps "a gate outage looks like an outage" rather than
    // manufacturing a spike in one of the three real reasons.
    return { accepted, classById, checked: toCheck.length, auto, dropped, droppedBy: { identity: 0, substance: 0, relevance: 0, unreported: dropped } };
  }
}

// --- Near-duplicate research dedup ---
// Two articles about the same event (or the same story re-surfacing weeks later) each
// pass the identity + relevance check and would each become a research_result signal —
// the enricher then writes overlapping facts and the feed shows "duplicates." Collapse
// them by embedding cosine before any signal is created.
// 0.83, not 0.88: three articles about one launch, each framed differently
// ("launched X" / "points-based payment model" / "diverse content"), embed far
// enough apart to clear 0.88 and all became separate signals. 0.83 collapses
// same-event-different-framing while staying above unrelated same-company news.
const DUP_SIM_THRESHOLD = 0.83;
export const DUP_LOOKBACK_DAYS = 90;
const DUP_MAX_PRIORS = 60;

/**
 * Given research candidates (in keep-priority order) and the bodies of research_result
 * signals already on the entity, return the ids to KEEP: the first of each near-identical
 * cluster, dropping later duplicates within this run and any candidate that merely restates
 * a prior signal. Uses embedding cosine (text-embedding-3-small), not string match, so
 * "media production" and "media production and archival" about the same partnership collapse.
 * Fails OPEN — any embed error keeps every candidate, because losing a real signal is worse
 * than letting one duplicate through (assert_fact still content-hashes downstream).
 */
export async function dedupeResearchCandidates(
  ordered: Array<{ id: string; body: string }>,
  priorBodies: string[],
): Promise<{ keep: Set<string>; dropped: number }> {
  const keep = new Set(ordered.map((c) => c.id));
  // Nothing to compare against (one candidate, no priors) → no work, no embed spend.
  if (ordered.length === 0 || ordered.length + priorBodies.length < 2) return { keep, dropped: 0 };
  try {
    const priorVecs = await Promise.all(
      priorBodies.slice(0, DUP_MAX_PRIORS).map((b) => embed(b.slice(0, 1500))),
    );
    const keptVecs: number[][] = [];
    let dropped = 0;
    for (const c of ordered) {
      const v = await embed(c.body.slice(0, 1500));
      const isDup = [...priorVecs, ...keptVecs].some((p) => cosine(v, p) >= DUP_SIM_THRESHOLD);
      if (isDup) { keep.delete(c.id); dropped++; }
      else keptVecs.push(v);
    }
    return { keep, dropped };
  } catch {
    return { keep, dropped: 0 };
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
