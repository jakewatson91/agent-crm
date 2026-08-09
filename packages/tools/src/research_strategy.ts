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
import { resolveBrief, PAIN_QUESTION } from './research_brief.ts';
import type { ResearchAngle, BriefQuestion, WorkspacePolicy } from './policy.ts';

// Pro, not flash: the planner runs rarely (≈once per workspace per 14 days, or on a
// guidance change) but every search the agent makes flows from it — same reasoning that
// puts the drafter on pro. A few cents per regeneration buys much better angles.
const PLANNER_MODEL = 'deepseek-v4-pro';
const STRATEGY_STALE_DAYS = 14;
// Exa bundles page content for the first 10 results into the search price for
// free, so there's no cost reason to stay lean — take the full 10 every time.
const DEFAULT_NUM_RESULTS = 10;

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
    num_results: 10,
    answers: 'moves',
  },
  {
    id: 'in_the_news',
    label: 'In the news',
    query_template: '{entity}',
    domain_scope: 'news',
    recency_days: 30,
    num_results: 10,
    answers: 'moves',
  },
  {
    id: 'who_they_sell_to',
    label: 'Who they sell to',
    query_template: '{entity} customers OR case study OR "trusted by" OR partners with',
    domain_scope: 'open_web',
    num_results: 10,
    answers: 'buyers',
  },
];

const VALID_SCOPES = new Set(['own_site', 'news', 'open_web', 'social']);

/**
 * Fixed angle set for searching a linked PERSON rather than the company —
 * what a real named contact has posted publicly. Unlike the company strategy
 * above, this is not AI-planned per workspace: "find what this named person
 * said" is a generic query shape, not something that varies by vertical, so
 * a fixed template avoids a planner LLM call for a case that doesn't need
 * one. {entity} substitutes the contact's name, {company} their account's
 * name (see buildAngleRequest in research.ts). maxAgeDays is threaded in so
 * the query-time Exa filter matches policy.research.contact_signal_max_age_days
 * rather than the company default.
 *
 * open_web only, deliberately no `social` angle: LinkedIn and X have no API
 * for reading a third party's posts, and scraping either one is a real ban /
 * legal risk (LinkedIn has litigated this for years), not something to build
 * into a product. Exa itself can't reach around that — it crawls public pages,
 * and almost everything on those platforms sits behind a login wall, so a
 * social-scoped contact search mostly returns the login-walled profile card,
 * not a post. What's actually reachable without a login is a person quoted in
 * an article, writing on their own company's site, or covered from a talk —
 * exactly what the open_web angle already searches for.
 */
export function resolveContactStrategy(maxAgeDays: number): ResearchAngle[] {
  return [
    {
      id: 'contact_public_posts',
      label: 'What they have posted publicly',
      query_template: '{entity} {company} post OR interview OR talk OR wrote OR announced',
      domain_scope: 'open_web',
      recency_days: maxAgeDays,
      num_results: 10,
      enabled: true,
    },
  ];
}

function slugify(s: string, fallback: string): string {
  const out = s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return out || fallback;
}

/** Normalize / validate one raw angle from the model into a ResearchAngle, or null. */
function coerceAngle(raw: unknown, idx: number, usedIds: Set<string>, validQuestionIds?: Set<string>): ResearchAngle | null {
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
  // Which brief question this angle is buying searches for. Only kept when it
  // names a real question — an invented id would make the per-angle yield
  // reporting lie about what the spend was for.
  const answers = typeof r.answers === 'string' && validQuestionIds?.has(r.answers) ? r.answers : undefined;
  return {
    id,
    label: typeof r.label === 'string' && r.label.trim() ? r.label.trim().slice(0, 60) : id,
    query_template: query_template.slice(0, 200),
    domain_scope: scope as ResearchAngle['domain_scope'],
    recency_days: recency,
    num_results: num,
    enabled: true,
    ...(answers ? { answers } : {}),
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
  // policy.research.max_age_days — the workspace's ingestion floor. The prompt
  // used to state a hardcoded 30 here, so on a workspace that had moved its
  // floor the planner authored angles against a number that was no longer
  // true, and any angle wider than the real floor bought results the runner
  // then binned. Stating the actual floor is what keeps the two in step.
  max_age_days?: number;
  /**
   * The workspace's research brief. The angles exist to answer these questions,
   * so the planner is given them and made to say which question each angle is
   * buying searches for. That is what makes waste visible: an angle whose pages
   * never answer its own question is spend to cut, and before this there was no
   * way to even ask which question a given angle was for.
   */
  brief?: BriefQuestion[];
  /**
   * Whether `name` is a company or a person.
   *
   * Contact research reuses this filter with a PERSON's name, and until this
   * existed the prompt still announced "TARGET COMPANY: name: <person>" and
   * asked whether each page was about that company. Pages genuinely about the
   * person were rejected for not being a company of the same name: measured on
   * two live contacts, 4 of 10 and 9 of 10 drops were identity, and across 1000
   * stored research pages the contact path had produced **zero** signals in its
   * entire history.
   *
   * Defaults to 'company', so every account pull behaves exactly as before.
   */
  subject?: 'company' | 'person';
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
    max_age_days: policy.research?.max_age_days,
    // Minus the always-on pain question: pain is something you NOTICE on a page
    // fetched for another reason, never something a search finds directly, so an
    // angle pointed at it would spend a search per account to return nothing.
    brief: resolveBrief(policy).filter((q) => q.id !== PAIN_QUESTION.id),
  };
  return { ctx, policy };
}

// The floor is interpolated rather than written as a literal: it is the
// workspace's policy.research.max_age_days, and a prompt that states a
// different number teaches the planner to author angles whose results the
// runner will bin. DEFAULT is only the fallback when the workspace has not set
// one.
const DEFAULT_PROMPT_FLOOR_DAYS = 30;
const sysPrompt = (floorDays = DEFAULT_PROMPT_FLOOR_DAYS, briefBlock = '') => `You design a small set of WEB SEARCH ANGLES an AI sales agent runs, per prospect company. Each angle becomes one Exa web search per company.
${briefBlock}
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
- "recency_days": a hard freshness floor — any dated result older than this (or older than ${floorDays} days if omitted on a non-evergreen angle) is dropped, regardless of domain_scope. NEVER set it above ${floorDays}: this workspace bins anything older than that on ingestion, so a wider window only buys results that cannot survive. Set it to 30 for news, launches, and "own_site" angles that target recent posts. Omit ONLY for a deliberately evergreen "own_site" angle (customer lists, general product pages) — an omitted value exempts UNDATED results from the floor, but a dated result on that same angle is still held to ${floorDays} days.
- "id": short slug. "label": short human title. "num_results": 10 (page content for up to 10 results per search is bundled free — always ask for the full 10).
- "answers": the id of the ONE brief question this angle exists to answer. Required. Every angle must be buying searches for a question; if you cannot name the question, the angle should not exist.

Do NOT search for jobs/careers/hiring — a separate connector covers hiring. Avoid aggregator, profile, and directory pages (funding databases, professional-network company pages) — they restate what we already know and give no hook.

WATCH THE SHAPE OF AN "own_site" ANGLE. Scoping to a company's own website means searching EVERY page they host, and most companies host far more help-centre articles, FAQs, terms, pricing tables and catalogue listings than they do announcements. An "own_site" angle built from loose OR-groups of common words will return those and nothing else — measured live, one such angle spent a third of the whole search budget on help pages in four languages. Phrase an "own_site" query around the words that appear on the kind of page you want (an announcement, a written post, a named case study) rather than around a topic that appears everywhere on their site.

Tailor query terms to who THIS workspace sells to and the problems they solve (below). Every must-include term provided must be covered by at least one angle.

Return JSON only: {"angles":[{"id","label","query_template","domain_scope","recency_days","num_results","answers"}]}`;

// Appended to SYS_PROMPT only when the workspace configured
// policy.research.social_domains — otherwise the model never sees the scope and
// can't plan angles the runner would skip.
/**
 * The brief, rendered for the planner. Every angle must name the question it
 * serves, so the model is shown the questions before it is asked for angles.
 */
function briefAddendum(brief: BriefQuestion[]): string {
  if (!brief.length) return '';
  return `
THE BRIEF — these are the questions this seller needs answered about each prospect. Your angles exist to answer them, and each angle must name the ONE question it serves in its "answers" field:
${brief.map((q) => `  ${q.id} — ${q.question}`).join('\n')}

Cover the questions that web search can actually answer. It is fine to leave a question with no angle when no search would find it, and fine for two angles to serve the same question from different directions. It is NOT fine to plan an angle that serves none of them.
`;
}

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
            ? `${sysPrompt(ctx.max_age_days, briefAddendum(ctx.brief ?? []))}\n\n${socialScopeAddendum(ctx.social_domains)}`
            : sysPrompt(ctx.max_age_days, briefAddendum(ctx.brief ?? [])),
        },
        { role: 'user', content: buildUserPayload(ctx) },
      ],
    });
    const parsed = JSON.parse(llm.text) as { angles?: unknown[] };
    const usedIds = new Set<string>();
    const angles: ResearchAngle[] = [];
    const validQuestionIds = new Set((ctx.brief ?? []).map((q) => q.id));
    for (const [i, raw] of (parsed.angles ?? []).entries()) {
      const a = coerceAngle(raw, i, usedIds, validQuestionIds);
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
 * Does this page actually name the company anywhere in its title, body or URL?
 *
 * Every off-domain angle already sends Exa `includeText: [entity name]`, but Exa
 * only honours that on keyword routes. Measured 2026-08-04 on the same query:
 * `type: 'neural'` returned 3/3 pages with no mention of the target at all —
 * identical to sending no filter — and `type: 'auto'` (what the runner sends)
 * honoured it on 2 of 3. So a search for a small brand plus topic words comes
 * back filled with the best pages about the TOPIC: "Weyyak concurrent viewers"
 * returned Naver Chzzk and UFC ratings. The LLM gate then correctly rejects
 * them, which is why identity was 55% of all drops — we were paying twice
 * (Exa, then the gate) for pages that never had a chance.
 *
 * This re-imposes the filter locally, for free, before the gate runs.
 * Deliberately loose — it is a junk filter, not a relevance judgement. Letting
 * junk through costs one LLM judgement, which is the status quo; dropping a real
 * page costs a signal, so every ambiguous case abstains. Measured on 65 live
 * candidates across 6 accounts, this dropped 0 pages the gate would have kept.
 *
 * A page matches on either the company name or the domain root, compared with
 * case and punctuation stripped, so "AB Films TV" matches "abfilmstv".
 *
 * A slash or a bracket means two brands, not one: "Videotron/Quebecor" and
 * "Astro (sooka)" are each written as only one half on any real page, so each
 * half is its own way in. Without that split, videotron.com's own pages were
 * flagged as the wrong company, and every article about sooka was dropped.
 *
 * `aliases` covers the case no string surgery can reach: a company the press
 * only ever calls by its product. Crazy Maple Studio (crazymaplestudios.com) is
 * covered as "ReelShort", so every genuine article about it fails both the name
 * and the domain test. Put the product name in the entity's
 * `attributes.aliases` and its coverage comes back — data, not a code change.
 *
 * Anything that short-circuits to a name people actually use makes the test
 * unsafe, so these abstain rather than judge:
 *   - an acronym domain (cbc.ca, wbd.com) — "cbc" is a substring of too much,
 *     and the full name is no help either, because a page about CBC/Radio-Canada
 *     writes "CBC" and never the run-together legal name
 *   - a short brand ("OSN+", "M6") — coverage says "OSN", so testing for
 *     "osnplus" would throw away every genuine page
 */
const MIN_DISCRIMINATING_CHARS = 4;

/**
 * The other names an entity is written under, read off `attributes.aliases`.
 *
 * One reader for every caller, so an alias added to an account behaves the same
 * everywhere it is checked: the research name gate, the contacts that work at
 * that account, and the watch-mode connectors. `attributes` is free-form JSON,
 * so anything that is not a non-empty string is ignored rather than trusted.
 */
export function readEntityAliases(attributes: unknown): string[] {
  const raw = (attributes as { aliases?: unknown } | null | undefined)?.aliases;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
    .map((a) => a.trim());
}

export function pageMentionsEntity(
  name: string,
  domain: string,
  page: { title?: string | null; url: string; text?: string },
  aliases: string[] = [],
): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const root = norm(domain.split('.')[0] ?? '');
  // The domain root is what makes this test trustworthy. With no domain the only
  // token left is the registered name, and coverage rarely writes that exactly:
  // "Warner Brothers Discovery" is reported as "Warner Bros. Discovery", which
  // shares no run-together substring, so testing anyway dropped four real
  // articles in a live run. An account with no domain also has no own_site angle
  // to protect, so abstaining costs nothing.
  if (!root) return true;
  // An acronym domain (cbc.ca) cannot be tested without dropping real pages.
  if (root.length < MIN_DISCRIMINATING_CHARS) return true;
  const parts = name.split(/[/()[\]]/).map(norm).filter(Boolean);
  // A brand whose usual short form is too generic to test for (OSN+, M6).
  if (parts.some((p) => p.length < MIN_DISCRIMINATING_CHARS)) return true;
  const tokens = [...parts, ...aliases.map(norm), root].filter((t) => t.length >= MIN_DISCRIMINATING_CHARS);
  if (!tokens.length) return true; // nothing discriminating to test against
  const hay = norm(`${page.title ?? ''} ${page.text ?? ''} ${page.url}`);
  return tokens.some((t) => hay.includes(t));
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
  /**
   * Which brief question each accepted page answers. This is the gate's real
   * output now: "keep it, and here is what it is FOR". The enricher reads it to
   * know which slot to fill, and it makes a wasted angle visible — an angle
   * whose pages never answer its own question is spend to cut, not a query to
   * re-tune.
   */
  answersById: Map<string, string>;
  checked: number;
  auto: number;
  dropped: number;
  /**
   * Which test each dropped page failed, so a collapse in research yield can be
   * read off the event log instead of reconstructed from config.
   *
   * `no_answer` is the bucket that matters: the page is genuinely about this
   * company and is a real page, it just answers nothing the workspace needs to
   * know. Help centres, pricing tables, terms of service and app-store listings
   * land here, and before the brief existed they were indistinguishable from a
   * launch announcement. `substance` and `relevance` are kept so older event-log
   * rows still read; the current gate does not fill them.
   */
  droppedBy: { identity: number; substance: number; relevance: number; no_answer: number; unreported: number };
  /** Per-page reject reason, same vocabulary as `droppedBy`. */
  rejectReasonById: Map<string, GateRejectReason>;
  /**
   * Batches whose model response could not be read at all. Non-zero means the
   * gate did not run on those pages and they were dropped rather than guessed
   * at — see the fail-closed note on the catch below.
   */
  unreadable_batches: number;
  /**
   * Pages the model listed in neither array, and which were therefore bucketed
   * as `no_answer`. Distinct from `unreadable_batches`: the gate DID answer, it
   * just skipped some pages. Non-zero is tolerable; a rising number means the
   * batch size or the output contract needs another look.
   */
  omitted: number;
}

export type GateRejectReason = 'identity' | 'substance' | 'relevance' | 'no_answer' | 'unreported';

/**
 * Pages per LLM call.
 *
 * Not a tuning knob — a correctness one. The gate used to send every angle's
 * results in ONE call and make the model echo each page's Exa id (a full URL)
 * back twice, in `matches` and in `rejects`. Measured on a real 23-page batch:
 * 6252 output tokens, 272 per page, against a production `max_tokens` of 1200
 * whose automatic retry tops out at 4000. So the response truncated, JSON.parse
 * threw, and the catch ran — which at the time accepted every own-domain page
 * unjudged and dropped every off-domain one. On the ViX account that kept
 * `ayuda.vix.com/.../Support` and threw away "ViX faces refund calls after World
 * Cup stream", which is the best hook a seller of delivery capacity could get.
 *
 * Across 246 production runs the failure rate was monotonic in batch size — 0%
 * at 5 pages, 38% at 11-20, 100% above 30 — which is what truncation looks like.
 *
 * Two changes remove the failure mode rather than raising a limit: pages are
 * addressed by their INDEX in the batch (one or two digits, not a URL), and a
 * batch is capped here. Ten pages of index-addressed verdicts is ~150 output
 * tokens against a 1200 budget, roughly a 40x margin.
 */
const GATE_BATCH = 10;

export interface RelevanceTarget {
  name: string;
  domain: string;
  context: string;
  /**
   * The workspace's research brief — the questions this seller needs answered
   * about a prospect. A page is kept only if it answers one of them.
   *
   * This replaced a three-test judgement (identity / substance / relevance)
   * whose third test asked the model to decide, in the abstract, whether a page
   * "plausibly connects to a problem area". That is a hard call to make
   * consistently and an impossible one to audit. "Which of these five questions
   * does this page answer, or none?" is multiple choice, which small models are
   * markedly better at, and every verdict comes with a reason you can read.
   *
   * Empty means no brief was passed; the gate then keeps any page that is about
   * the right company and carries real content, which is the pre-brief
   * behaviour and the safe default for a caller that has none.
   */
  brief?: BriefQuestion[];
  /**
   * Whether `name` is a company or a person.
   *
   * Contact research reuses this filter with a PERSON's name, and until this
   * existed the prompt still announced "TARGET COMPANY: name: <person>" and
   * asked whether each page was about that company. Pages genuinely about the
   * person were rejected for not being a company of the same name: measured on
   * two live contacts, 4 of 10 and 9 of 10 drops were identity, and across 1000
   * stored research pages the contact path had produced **zero** signals in its
   * entire history.
   *
   * Defaults to 'company', so every account pull behaves exactly as before.
   */
  subject?: 'company' | 'person';
}

/**
 * Keep a page only if it is about THIS company and answers something the
 * workspace actually needs to know.
 *
 * Own-domain pages are not auto-accepted. Being on their own site proves
 * identity and nothing else — a company's own help centre is on their own
 * domain, and so is their privacy policy. Identity is handed to the model as
 * already-settled for those pages so it only has to judge the useful part.
 */
export async function filterResultsByEntity(
  target: RelevanceTarget,
  results: Array<{ id: string; title: string | null; url: string; text?: string }>,
  opts?: { model?: string; batch_size?: number },
): Promise<RelevanceResult> {
  const accepted = new Set<string>();
  const classById = new Map<string, HookClass>();
  const answersById = new Map<string, string>();
  const rejectReasonById = new Map<string, GateRejectReason>();
  const droppedBy = { identity: 0, substance: 0, relevance: 0, no_answer: 0, unreported: 0 };

  const brief = (target.brief ?? []).filter((q) => q?.id && q?.question);
  const toCheck = results.map((r) => {
    const host = hostOf(r.url);
    const own = !!target.domain && !!host && (host === target.domain || host.endsWith(`.${target.domain}`));
    return { r, own };
  });
  if (!toCheck.length) {
    return { accepted, classById, answersById, checked: 0, auto: 0, dropped: 0, droppedBy, rejectReasonById, unreadable_batches: 0, omitted: 0 };
  }

  // With real grounding an unsure-but-fitting page is probably right, so lean toward
  // matching. With nothing to test against, "fits the description" is untestable — a
  // generic same-name landing page would pass by default — so the bias flips.
  const isPerson = target.subject === 'person';
  const hasContext = target.context.trim().length >= 40;
  const unsureRule = hasContext
    ? 'When genuinely unsure whether it is the right company AND the page fits the description above, treat identity as satisfied.'
    : 'Almost nothing is known about the target, so identity cannot be confirmed from a description. Treat identity as satisfied only for a page that references the target\'s website domain or is unmistakably the same organization. When unsure, reject for identity.';

  const questionBlock = brief.length
    ? brief.map((q) => `  ${q.id} — ${q.question}${q.why ? ` (why it matters: ${q.why})` : ''}`).join('\n')
    : '';

  // A person's own words are the hook, whatever question they touch. Holding a
  // contact page to a list of questions written about COMPANIES is what killed
  // whatever survived the identity test: an exec's conference talk answers
  // "how much video do they serve" only by accident. The seller's own guidance
  // says a named person on the record is the strongest trigger there is, so for
  // a person the questions rank the page, they do not gate it.
  const personKeepRule = `2. It carries something this person actually SAID or WROTE, or reports something they did: a post, an interview, a quote, a talk, a panel, an article of theirs, an appointment or a decision attributed to them. That is the whole bar, and it does not depend on the questions below — a person on the record is worth reading whatever they were talking about.
Set "q" to whichever question below their words bear on, or to "" when none of them fit. "" is a normal answer here and does not mean reject.
Reject with "no_answer" only when the page names them but carries nothing they said or did: a staff directory entry, a profile page, a list of speakers with no talk, a page that merely mentions them in passing.
${brief.length ? `\nQUESTIONS THIS SELLER NEEDS ANSWERED (for ranking, not for gating):\n${questionBlock}` : ''}`;

  const keepRule = isPerson
    ? personKeepRule
    : brief.length
    ? `2. It ANSWERS at least one of the questions below, or contains something a researcher would file under one of them. Give the id of the single question it answers best.

QUESTIONS THIS SELLER NEEDS ANSWERED:
${questionBlock}

A page counts if it either states an answer outright — a number, a name, a date, a decision, a stated plan, a direct quote — OR reports something that is direct evidence bearing on the question, even without the exact figure. A report that a company's service struggled under a record audience bears on a question about audience size and on a question about how they deliver, and is worth keeping; so is an account of them preparing their platform for a known upcoming surge. What does not count is a page that merely shares a topic with the question while saying nothing specific about this company.
Reject with "no_answer" when the page bears on none of them. Most pages will. Being about the right company is not enough, and neither is being interesting. Help centres, FAQs, pricing tables, terms of service, privacy policies, cookie notices, login pages, app-store listings, job boards, catalogue and programme-listing pages, and directory entries almost never bear on any of these — reject them.
Reject an ENCYCLOPEDIA or WIKI article about the company. It reads like a substantive write-up — it has history, dates, ownership, product names — and that is exactly the trap: every fact on it is background already known or trivially knowable, assembled by a stranger rather than reported by the company or the press. Observed live: a wiki article on a streaming service was kept as an "event" and mined for eleven facts including its original launch year, its former name and its picture format, none of which any message could open on. If the page's job is to summarise what a thing IS, reject it, whatever question it appears to touch.
Reject a PERSON'S profile page too — a page that is somebody's professional-network profile, staff-directory entry or author page, listing their job title and history. It is not the same as something that person WROTE or SAID, which is often exactly what you want: a post, a talk, an interview or an article by them is a real answer. The test is whether the page carries their words about the company. A profile carries their job title, which answers nothing.`
    : `2. It carries substantive content: news, a launch, a blog post, a case study, an interview, a partnership, a write-up with real detail. Help centres, FAQs, pricing tables, terms of service, login pages, directory listings and company-profile pages are NOT substantive — they restate what is already known. Reject those with "no_answer".`;

  const header = isPerson
    ? `You screen web pages an AI sales agent fetched about a specific PERSON at a prospect company. You decide which ones are worth reading and what each one is for.

TARGET PERSON:
- name: ${target.name}
- where they work: ${target.context || '(unknown)'}
- their employer's website: ${target.domain || '(unknown)'}

KEEP a page only if BOTH hold:
1. It is BY or ABOUT this person — they wrote it, they are quoted or interviewed in it, they spoke at the thing it covers, or it reports on something they did. People share names, so it must be the one at that employer, not someone else with the same name in another field. A page about their employer that never mentions them is NOT about this person; drop it for identity, the company is researched separately.`
    : `You screen web pages an AI sales agent fetched about a prospect company. You decide which ones are worth reading and what each one is for.

TARGET COMPANY:
- name: ${target.name}
- website: ${target.domain || '(unknown)'}
- about: ${target.context || '(nothing known)'}

KEEP a page only if BOTH hold:
1. It is about THIS company.`;

  const sys = `${header}${isPerson ? '' : ` A company in a different industry, sector, or country that happens to share the name is NOT this company. A page whose real subject is a DIFFERENT company — a supplier's case study or press release about that supplier's own project, where the target appears only as one of their customers — is not about the target either. This does NOT apply to a parent, owner or operator reporting on the target itself: a group's results announcement giving the target's own numbers is about the target, and is often the only place those numbers are published. ${unsureRule}
   Some pages are marked "own site" in the input. Those are served from the target's own website, so identity is already settled: never reject one for identity.`}
${keepRule}

For every page you KEEP, also say what kind of hook it carries:
  "event"     — something dated HAPPENED: a launch, expansion, deal, published number, hire, or a person there saying something tied to a moment.
  "direction" — evidence of a current priority or push, with no single dated event.
  "profile"   — describes what the company is or does. Least valuable; say so honestly rather than upgrading it.

Pages are numbered. Refer to each one ONLY by its number.

Return JSON only, in exactly this shape:
{"keep":[{"i":<number>,"q":"<question id${brief.length && !isPerson ? '' : ' or empty string'}>","c":"event"|"direction"|"profile"}],
 "drop":[{"i":<number>,"f":"identity"|"no_answer"}]}

Account for EVERY page number you were given: each appears exactly once, in "keep" or in "drop". Count them before you answer — a page you leave out of both is treated as a drop, so an omission silently throws work away. Keep it terse: no prose, no explanations.
For every entry in "keep", "c" is required. If you are keeping a page you must say what kind of hook it carries.`;

  const batchSize = Math.max(1, opts?.batch_size ?? GATE_BATCH);
  const validQ = new Set(brief.map((q) => q.id));
  let unreadable_batches = 0;
  let omitted = 0;

  // Batches are independent, so they go out together. Capping the batch at 10
  // turned one LLM call into up to five, and run serially that added a minute to
  // every research run on a well-covered account — the accounts worth the most.
  const chunks: Array<typeof toCheck> = [];
  for (let start = 0; start < toCheck.length; start += batchSize) chunks.push(toCheck.slice(start, start + batchSize));

  // Each batch resolves to its own verdicts; they are merged in batch order below
  // so the result is identical however the calls interleave.
  const verdicts = await Promise.all(chunks.map(async (chunk) => {
    const keeps: Array<{ i: number; q?: string; c?: string }> = [];
    const drops: Array<{ i: number; f: GateRejectReason }> = [];
    const payload = chunk
      .map((c, i) => `#${i} ${c.own ? '[own site] ' : ''}${c.r.title ?? '(untitled)'}\n${c.r.url}\n${(c.r.text ?? '').slice(0, 500).replace(/\s+/g, ' ')}`)
      .join('\n\n');
    try {
      const llm = await chatComplete({
        model: opts?.model ?? RELEVANCE_MODEL,
        // Classification, not writing. Two runs over the same 23 stored ViX pages
        // at the default temperature kept 10 and then 7, disagreeing on a
        // subscriber-count story and a founder's post — which makes the gate's
        // verdict partly a coin toss and makes any A/B against it unreadable.
        temperature: 0,
        // Index-addressed verdicts for `batchSize` pages, with room to spare.
        // The old budget was 1200 for an unbounded batch of URL-addressed ones.
        max_tokens: 900,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: sys }, { role: 'user', content: payload }],
      });
      const parsed = JSON.parse(llm.text) as {
        keep?: Array<{ i?: number; q?: string; c?: string }>;
        drop?: Array<{ i?: number; f?: string }>;
      };
      const seen = new Set<number>();
      for (const k of parsed.keep ?? []) {
        const i = Number(k?.i);
        if (!Number.isInteger(i) || i < 0 || i >= chunk.length || seen.has(i)) continue;
        seen.add(i);
        keeps.push({ i, q: k.q, c: k.c });
      }
      for (const d of parsed.drop ?? []) {
        const i = Number(d?.i);
        if (!Number.isInteger(i) || i < 0 || i >= chunk.length || seen.has(i)) continue;
        seen.add(i);
        drops.push({ i, f: d.f === 'identity' ? 'identity' : 'no_answer' });
      }
      // Anything the model never mentioned. It did answer, so this is not an
      // outage — it just skipped a page. Dropping is the safe reading: an
      // unjudged page is exactly what used to fill the book with help-centre
      // articles.
      // A page the model listed in neither array. It answered the call, so this
      // is sloppiness rather than an outage, and in practice "not listed as a
      // keep" means the same thing as no_answer — so it is bucketed there and
      // counted separately in `omitted`, which is the number to watch if yield
      // ever looks wrong.
      let omitted = 0;
      for (let i = 0; i < chunk.length; i++) if (!seen.has(i)) { drops.push({ i, f: 'no_answer' }); omitted++; }
      return { chunk, keeps, drops, unreadable: false, omitted };
    } catch {
      // FAIL CLOSED. The old behaviour here was to keep every own-domain page
      // unjudged, on the reasoning that losing real own-site context is worse
      // than admitting one off-topic page. Live data says otherwise: when this
      // path ran it was the single largest source of junk in the book, because
      // "on their own domain" describes their help centre and their terms of
      // service as accurately as their launch blog. A page nobody judged is now
      // dropped. The dispatcher re-researches on cadence, so the cost of
      // dropping is one delayed pass; the cost of keeping was a permanent bad
      // fact the drafter reads forever.
      return { chunk, keeps: [], drops: chunk.map((_, i) => ({ i, f: 'unreported' as GateRejectReason })), unreadable: true, omitted: 0 };
    }
  }));

  for (const v of verdicts) {
    if (v.unreadable) unreadable_batches += 1;
    omitted += v.omitted;
    for (const k of v.keeps) {
      const id = v.chunk[k.i]!.r.id;
      accepted.add(id);
      // A keep whose class the model left off or garbled falls to `profile`, the
      // lowest weight, rather than staying unclassified. Unclassified used to
      // mean FULL magnitude (`HOOK_CLASS_WEIGHT[...] ?? 1`), so the gate saying
      // "keep this but I won't say what it's good for" produced a signal that
      // outranked a judged launch. Measured on the first live run under the
      // brief: 11 of 25 kept pages came back with no class. The conservative
      // reading of "kept, reason unstated" is the weakest kind of keep.
      const cls: HookClass = k.c === 'event' || k.c === 'direction' || k.c === 'profile' ? k.c : 'profile';
      classById.set(id, cls);
      // An unrecognised question id means the model invented one; the page is
      // still kept (it judged the page useful) but the slot is left unset so
      // the enricher does not write facts into a namespace that isn't real.
      if (k.q && (validQ.size === 0 || validQ.has(k.q))) answersById.set(id, k.q);
    }
    for (const d of v.drops) {
      droppedBy[d.f] += 1;
      rejectReasonById.set(v.chunk[d.i]!.r.id, d.f);
    }
  }

  return {
    accepted,
    classById,
    answersById,
    checked: toCheck.length,
    auto: 0,
    dropped: toCheck.length - accepted.size,
    droppedBy,
    rejectReasonById,
    unreadable_batches,
    omitted,
  };
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
