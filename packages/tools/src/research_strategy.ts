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
import { embed } from '@agent-crm/primitives';
import { getPolicy, invalidatePolicyCache } from './policy.ts';
import { chatCompleteForWorkspace } from './chat_workspace.ts';
import { runExaSearch } from './exa_search.ts';
import { cosine } from './icp_embeddings.ts';
import {
  resolveBrief,
  PAIN_QUESTION,
  FAIR_TRIAL_PAGES,
  earnsItsSearches,
  unreachableQuestions,
  loadQuestionSearchRecords,
  UNREACHABLE_WINDOW_DAYS,
  type QuestionSearchRecord,
} from './research_brief.ts';
import { fetchAll } from './paginate.ts';
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

const MAX_QUERY_CHARS = 200;

/**
 * Hold a query template to its length cap without shipping a broken query.
 *
 * A hard slice cuts mid-token and mid-group. Observed live on a planner run:
 * `... ("CDN cost" OR "delivery costs") (said OR explained OR desc` — a
 * half-written word inside an OR-group that was never closed, sent to Exa as-is.
 * Cut on a word boundary, then drop any group left hanging open, so what
 * survives is always a complete query rather than a prefix of one.
 */
export function clampQuery(q: string): string {
  if (q.length <= MAX_QUERY_CHARS) return q;
  let out = q.slice(0, MAX_QUERY_CHARS);
  const lastSpace = out.lastIndexOf(' ');
  if (lastSpace > 0) out = out.slice(0, lastSpace);
  // An unmatched "(" means the trailing group was cut short — drop it whole.
  for (;;) {
    const opens = (out.match(/\(/g) ?? []).length;
    const closes = (out.match(/\)/g) ?? []).length;
    if (opens <= closes) break;
    const at = out.lastIndexOf('(');
    if (at < 0) break;
    out = out.slice(0, at);
  }
  // Same for a quote left open by the cut.
  if (((out.match(/"/g) ?? []).length) % 2 === 1) out = out.slice(0, out.lastIndexOf('"'));
  return out.trim();
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
  // With a brief in play the prompt calls `answers` required and says an angle
  // that cannot name its question should not exist. Enforce that here rather than
  // hoping: an unattributed angle spends on every account forever and appears in
  // no question's record, so nothing downstream can ever judge it — and the
  // questions the record has ruled unsearchable are withheld from the planner, so
  // an angle arriving with no question is the one way that ruling gets bypassed.
  if (validQuestionIds?.size && !answers) return null;
  return {
    id,
    label: typeof r.label === 'string' && r.label.trim() ? r.label.trim().slice(0, 60) : id,
    query_template: clampQuery(query_template),
    domain_scope: scope as ResearchAngle['domain_scope'],
    recency_days: recency,
    num_results: num,
    enabled: true,
    ...(answers ? { answers } : {}),
  };
}

/**
 * What one angle bought, summed off the `research_completed` run markers. Both
 * numbers are already written per run (`per_angle_fetched`, `per_angle`) and are
 * keyed by angle id, so nothing new is stored to produce this.
 *
 * fetched and kept are kept apart for the same reason the scorecard keeps its
 * columns apart: a low keep rate is a bad SEARCH, and reading it as a bad
 * QUESTION is how a question that was working gets deleted.
 */
export interface AngleRecord {
  id: string;
  /** Pages this angle's searches brought back. From the run markers. */
  fetched: number;
  /**
   * Of those, how many were kept AS ANSWERING THE QUESTION THIS ANGLE SERVES.
   *
   * Not "kept at all", which is a different and much weaker number. Measured on
   * the angle this was built for: it fetched 183 pages and 16 were kept, so by
   * pages-kept it looked like a working search — but ZERO of them answered
   * technical_leader, the question it existed to answer. They were LinkedIn pages
   * that happened to say something the gate filed under another question. Judging
   * the angle on the weaker number would have declared it healthy while the
   * question it was bought for went unanswered for 14 days.
   *
   * Signals carry both `research_angle` and `answers_question`, so this is read
   * off them directly rather than inferred.
   */
  kept: number;
}

/** How far back the record is summed. Wider than the 14-day regeneration cycle. */
const RECORD_WINDOW_DAYS = 30;

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
   * The angles currently in place, and what each one bought.
   *
   * The brief planner has had a track record since the scorecard landed, and its
   * prompt tells it "the SEARCH is finding the wrong pages, rewrite its query" —
   * but the brief planner writes QUESTIONS, not queries, so the verdict the
   * scorecard reaches most often had nothing that could act on it.
   *
   * Measured 2026-08-10 on Sudden: one angle fetched 183 pages in a single day
   * and kept zero, and would have gone on doing that until a human read a
   * scorecard. With the record in front of it, the planner that writes the
   * queries can rewrite that angle on its own evidence.
   */
  previous?: ResearchAngle[];
  records?: AngleRecord[];
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
 * Sum per-angle fetched/kept off the run markers. Runs only when the strategy is
 * being regenerated (once per workspace per 14 days), so the events read is cheap.
 * Any failure returns an empty record set: a missing track record must never stop
 * a regeneration, it only means the planner plans blind as it did before.
 */
export async function loadAngleRecords(supabase: SupabaseClient, workspace_id: string, previous: ResearchAngle[]): Promise<AngleRecord[]> {
  try {
    const since = new Date(Date.now() - RECORD_WINDOW_DAYS * 86400 * 1000).toISOString();
    // Capped at 1000 by PostgREST whatever the limit said, and this workspace
    // passed that inside the window. Same read, same fix, same reason as the
    // one in scanQuestionSearch: it is the pages an angle cost, and it is
    // divided by what the angle kept.
    const data = await fetchAll<{ payload: Record<string, unknown> | null; created_at: string }>((from, to) =>
      supabase.from('events').select('payload, created_at')
        .eq('workspace_id', workspace_id).eq('action', 'research_completed')
        .gte('created_at', since).order('created_at').order('id').range(from, to));
    // A run only counts toward an angle if it ran the search that angle carries
    // NOW. Without this a rewritten query inherits the record of the one it
    // replaced, and the planner judges a query that has never run.
    const startedAt = new Map(previous.map((a) => [a.id, a.record_since ? Date.parse(a.record_since) : 0]));
    const fetched: Record<string, number> = {};
    for (const e of (data ?? []) as Array<{ payload: Record<string, unknown> | null; created_at: string }>) {
      const at = Date.parse(e.created_at);
      const p = (e.payload ?? {}) as Record<string, Record<string, number> | undefined>;
      for (const [k, v] of Object.entries(p.per_angle_fetched ?? {})) {
        if (at < (startedAt.get(k) ?? 0)) continue;
        fetched[k] = (fetched[k] ?? 0) + (Number(v) || 0);
      }
    }

    // Kept comes off the signals, not off per_angle in the marker, because
    // per_angle counts pages this angle kept for ANY question. See AngleRecord.kept.
    const answersOf = new Map(previous.map((a) => [a.id, a.answers]));
    const kept: Record<string, number> = {};
    // fetchAll for the same two reasons as the question scan in research_brief:
    // the loop this replaces dropped the read error and then treated the empty
    // page as the end of the table, and it paged without a stable order. Either
    // one reports zero keeps for an angle that is working, and zero keeps
    // against real pages fetched is what fails an angle. The throw is caught
    // below and answers with no records, which is a missing verdict rather than
    // a wrong one.
    const sigs = await fetchAll<{ structured_tags: Record<string, string> | null; observed_at: string }>((from, to) =>
      supabase.from('signals').select('structured_tags, observed_at')
        .eq('workspace_id', workspace_id).eq('type', 'research_result')
        .gte('observed_at', since).order('observed_at').order('id').range(from, to));
    for (const s of sigs) {
      const angleId = s.structured_tags?.research_angle;
      if (!angleId || !startedAt.has(angleId)) continue;
      if (Date.parse(s.observed_at) < (startedAt.get(angleId) ?? 0)) continue;
      // An angle planned before the brief existed has no question to be judged
      // against, so any keep counts for it.
      const wants = answersOf.get(angleId);
      if (wants && s.structured_tags?.answers_question !== wants) continue;
      kept[angleId] = (kept[angleId] ?? 0) + 1;
    }

    return [...new Set([...Object.keys(fetched), ...Object.keys(kept)])]
      .map((id) => ({ id, fetched: fetched[id] ?? 0, kept: kept[id] ?? 0 }));
  } catch {
    return [];
  }
}

/**
 * The angles in place, each with what it bought, rendered for the planner.
 *
 * Mirrors the brief planner's continuity block deliberately, including the id
 * rule: the record is filed under the angle id, so a renamed id starts the
 * record from zero and the next regeneration is blind again.
 */
export function angleRecordBlock(previous: ResearchAngle[], records: AngleRecord[]): string {
  if (!previous.length) return '';
  const byId = new Map(records.map((r) => [r.id, r]));
  const recordLine = (a: ResearchAngle): string => {
    const r = byId.get(a.id);
    if (!r || r.fetched < FAIR_TRIAL_PAGES) return `    [only ${r?.fetched ?? 0} pages seen so far — TOO EARLY TO JUDGE, keep it as it is]`;
    const hit = Math.round((r.kept / r.fetched) * 100);
    let read: string;
    if (r.kept === 0) read = 'this query CANNOT work as written — not one page it bought answered the question it is for. Rewrite it, or change its domain_scope, or replace the angle entirely';
    else if (!earnsItsSearches(r)) read = `this query is buying mostly the wrong pages — it has answered its question ${r.kept} time(s) in ${r.fetched} pages. Rewrite it`;
    else read = 'earning its place — keep it, and keep its wording close';
    return `    [${r.fetched} pages seen, ${r.kept} answered its question (${hit}%) -> ${read}]`;
  };
  return `

THE ANGLES ALREADY IN PLACE, AND WHAT EACH ONE BOUGHT (last ${RECORD_WINDOW_DAYS} days):

${previous.map((a) => `  ${a.id} [${a.domain_scope}] answers=${a.answers ?? '-'}: ${a.query_template}\n${recordLine(a)}`).join('\n')}

Keep the id EXACTLY as written for any angle you keep, even if you rewrite its query — the record is filed under the id, and a renamed id starts it from zero.

A poor record is a bad SEARCH, not a bad question. Rewrite the query or move it to a different domain_scope; do not stop covering the brief question it answers. An angle that is earning its place stays as it is: do not reword a working query, and do not drop the question it serves in order to fit a new angle in.`;
}

/**
 * The questions worth pointing a search at — what the planner is allowed to see.
 *
 * Withholding a question IS the enforcement: the planner writes angles only for
 * what it is shown, so nothing downstream needs a new switch to read, get wrong,
 * or carry across a regeneration. That makes this the definition of where research
 * money goes, so it is one function rather than a filter written out at each call
 * site.
 *
 * Two exemptions, and they are the same exemption reached two ways. `pain` is
 * known in advance to be unsearchable — it is something you NOTICE on a page
 * fetched for another reason, so an angle pointed at it would spend a search per
 * account to return nothing. The rest are learned from the record. Both stay in
 * the brief and are still read by the gate and the extractor; pain is the proof
 * that has to be true, since a page reporting a company's service buckling under
 * load answers no other question and is the most valuable page research finds.
 */
export function questionsWorthSearching(policy: WorkspacePolicy, records: QuestionSearchRecord[]): BriefQuestion[] {
  const unreachable = new Set(unreachableQuestions(records));
  return resolveBrief(policy).filter((q) => q.id !== PAIN_QUESTION.id && !unreachable.has(q.id));
}

async function loadContext(supabase: SupabaseClient, workspace_id: string): Promise<{ ctx: PlannerContext; policy: WorkspacePolicy }> {
  const policy = await getPolicy(supabase, workspace_id);
  const w = await supabase.from('workspaces').select('about, icp').eq('id', workspace_id).maybeSingle();
  // Derived, not stored. A persisted verdict would need carrying across every
  // brief regeneration and clearing on some rule nobody would remember to write
  // — this session has already lost two feedback loops to exactly that. Deriving
  // it costs one events read plus one signals scan on a path that runs at most
  // twice a day per workspace, and it can never go stale or contradict the
  // scorecard. A failure here returns nothing, which plans as it always did.
  const records = await loadQuestionSearchRecords(supabase, workspace_id, UNREACHABLE_WINDOW_DAYS).catch(() => []);
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
    brief: questionsWorthSearching(policy, records),
    previous: policy.research?.strategy ?? [],
    records: await loadAngleRecords(supabase, workspace_id, policy.research?.strategy ?? []),
  };
  return { ctx, policy };
}

// The floor is interpolated rather than written as a literal: it is the
// workspace's policy.research.max_age_days, and a prompt that states a
// different number teaches the planner to author angles whose results the
// runner will bin. DEFAULT is only the fallback when the workspace has not set
// one.
const DEFAULT_PROMPT_FLOOR_DAYS = 30;

/**
 * Most angles a plan may contain, and the number the prompt asks for.
 *
 * It is a spend decision, not a formatting one: a hot account costs one search
 * per angle, so this multiplies straight into the per-tick budget. The cap sat
 * at 6 while the prompt asked for "3 to 5", and the first plan after the planner
 * was repaired took the code's number rather than the prompt's — which pushed a
 * hot account from 5 searches to 6 and cut the high-value bucket from 1.8
 * accounts a tick to 1. Interpolated into the prompt below so the two can never
 * disagree again.
 */
const MAX_PLANNED_ANGLES = 5;
const sysPrompt = (floorDays = DEFAULT_PROMPT_FLOOR_DAYS, briefBlock = '') => `You design a small set of WEB SEARCH ANGLES an AI sales agent runs, per prospect company. Each angle becomes one Exa web search per company.
${briefBlock}
Return 3 to ${MAX_PLANNED_ANGLES} angles. Fewer, sharper angles beat many overlapping ones. Anything past the ${MAX_PLANNED_ANGLES}th is discarded, so do not spend one on an angle you would rank last.

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
    "social"    -> restricted to: ${domains.join(', ')}. Posts, talks, and interviews BY the prospect company's founders and executives — the concrete trigger a first-touch message can reference ("saw your post on X"). Include AT MOST ONE social angle, and only if a person speaking is reachable on those hosts without a login. Where a host's public pages are mostly member profiles, this scope returns profile cards however the query is phrased — the search already requires the company name, and the commonest page naming a company on such a host is an employee's profile. In that case plan no social angle: cover the question from news or the open web, where a talk, panel or interview write-up is a readable page. If you do plan one, phrase its query_template to surface a person speaking (post, talk, interview, panel, announcement by {entity} leadership), NOT the company's profile page — this is the one exception to the profile/directory-page rule above. Exec posts go stale fast: set recency_days 30.`;
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
 * Plan angles from an already-built context. Used by the regenerate endpoint,
 * which builds context from freshly-derived About fields. Falls back to
 * BASELINE_ANGLES on any error or empty result.
 *
 * Takes the workspace because the call goes through chatCompleteForWorkspace:
 * that is what lets a customer name the planner's model in settings, and what
 * makes the call use the customer's own DeepSeek key instead of the
 * deployment's. Before that it called chatComplete directly and did neither.
 */
export async function planResearchAngles(
  supabase: SupabaseClient,
  workspace_id: string,
  ctx: PlannerContext,
  opts?: { model?: string },
): Promise<{ angles: ResearchAngle[]; source: 'ai' | 'baseline'; error?: string }> {
  // Nothing to plan from -> neutral baseline, no LLM spend.
  if (!ctx.about && !ctx.guidance && !ctx.always_include.length && !ctx.value_props.length) {
    return { angles: BASELINE_ANGLES, source: 'baseline' };
  }
  try {
    const llm = await chatCompleteForWorkspace(supabase, workspace_id, {
      behavior: 'research_planner',
      model: opts?.model ?? PLANNER_MODEL,
      // The same fix the relevance gate got on 2026-08-14, in the one
      // fixed-shape JSON call that was missed by that sweep. DeepSeek counts
      // reasoning tokens against max_tokens, and on a prompt this size the
      // planner spent all 1200 of them thinking and returned JSON that stopped
      // mid-object. The roomy retry and the fallback model did the same, so the
      // ladder could not rescue it and every attempt landed on BASELINE_ANGLES.
      // Measured: Sudden's angles had not changed since 2026-08-11 while the
      // strategy stamp read "today", and two questions the loop had already
      // ruled unanswerable went on buying searches because dropping them needs
      // one successful plan. Pinned by scripts/check_thinking_off.ts.
      thinking: 'disabled',
      max_tokens: 1200,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: ctx.social_domains?.length
            ? `${sysPrompt(ctx.max_age_days, briefAddendum(ctx.brief ?? []))}\n\n${socialScopeAddendum(ctx.social_domains)}`
            : sysPrompt(ctx.max_age_days, briefAddendum(ctx.brief ?? [])),
        },
        { role: 'user', content: `${buildUserPayload(ctx)}${angleRecordBlock(ctx.previous ?? [], ctx.records ?? [])}` },
      ],
    });
    let parsed: { angles?: unknown[] };
    try {
      parsed = JSON.parse(llm.text) as { angles?: unknown[] };
    } catch (e) {
      // "Unexpected end of JSON input" on its own names neither the cause nor
      // the rung it died on, and that is what nine days of silent fallbacks
      // looked like from the outside. finish_reason plus the output count
      // separates the two failures that land here: `length` with no text is the
      // model reasoning past its ceiling, anything else is a malformed reply.
      throw new Error(`planner returned unparseable JSON (${e instanceof Error ? e.message : String(e)}) — finish=${llm.finish_reason ?? 'unknown'} output_tokens=${llm.output_tokens} text=${llm.text.length}ch model=${llm.model}`);
    }
    const usedIds = new Set<string>();
    const angles: ResearchAngle[] = [];
    const validQuestionIds = new Set((ctx.brief ?? []).map((q) => q.id));
    for (const [i, raw] of (parsed.angles ?? []).entries()) {
      const a = coerceAngle(raw, i, usedIds, validQuestionIds);
      if (a) angles.push(a);
      if (angles.length >= MAX_PLANNED_ANGLES) break;
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
  return planResearchAngles(supabase, workspace_id, ctx, opts);
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
   * Why those batches could not be read, deduplicated. The catch used to
   * discard the error, so the run marker said "unreadable" and nothing else —
   * a model out of credit, a timeout and an output ceiling too small to reach
   * the answer all looked identical, and telling them apart meant reproducing
   * the batch by hand. Empty whenever unreadable_batches is 0.
   */
  unreadable_reasons: string[];
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
 * Why one gate batch could not be read, in words an operator can act on.
 *
 * Three failures used to look identical in the run marker, and they need three
 * different responses: the provider refusing the call (top up the account, fix
 * the key), an answer that arrived empty (the output ceiling cannot reach the
 * verdict), and an answer that arrived malformed (the prompt contract slipped).
 * The provider message is passed through verbatim on the first, because that is
 * the one a person has to go and fix.
 */
export function gateFailureReason(
  ctx: { answered: boolean; text: string; finish: string; error: unknown },
): string {
  const msg = ctx.error instanceof Error ? ctx.error.message : String(ctx.error);
  const reason = !ctx.answered
    ? msg
    : ctx.text.trim()
    ? `model returned unparseable JSON: ${msg}`
    : `model returned no content (finish_reason=${ctx.finish || 'unknown'})`;
  return reason.slice(0, 200);
}

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
  supabase: SupabaseClient,
  workspace_id: string,
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
    return { accepted, classById, answersById, checked: 0, auto: 0, dropped: 0, droppedBy, rejectReasonById, unreadable_batches: 0, unreadable_reasons: [], omitted: 0 };
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
    // Kept outside the try so the catch can say which of the three failures
    // this was: the call never came back, it came back empty, or it came back
    // with something that is not JSON. They need different fixes.
    let answered = false;
    let text = '';
    let finish = '';
    try {
      const llm = await chatCompleteForWorkspace(supabase, workspace_id, {
        behavior: 'research_relevance',
        model: opts?.model ?? RELEVANCE_MODEL,
        // Classification, not writing. Two runs over the same 23 stored ViX pages
        // at the default temperature kept 10 and then 7, disagreeing on a
        // subscriber-count story and a founder's post — which makes the gate's
        // verdict partly a coin toss and makes any A/B against it unreadable.
        temperature: 0,
        // Same reason, taken one step further: no thinking either. A batch of 10
        // needs ~4,300 reasoning tokens before it writes a single character of
        // the verdict, which does not fit under max_tokens and did not fit under
        // the 4000-token retry — the model returned an empty string and the
        // whole batch was dropped unjudged. On 2026-08-14 that was 36% of runs
        // and 269 pages, all of them already paid for at Exa. Off, the same
        // batch answers in ~150 tokens and 2 seconds.
        thinking: 'disabled',
        // Index-addressed verdicts for `batchSize` pages, with room to spare.
        // The old budget was 1200 for an unbounded batch of URL-addressed ones.
        max_tokens: 900,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: sys }, { role: 'user', content: payload }],
      });
      answered = true;
      text = llm.text ?? '';
      finish = llm.finish_reason ?? '';
      const parsed = JSON.parse(text) as {
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
      return { chunk, keeps, drops, unreadable: false, omitted, reason: '' };
    } catch (e) {
      // FAIL CLOSED. The old behaviour here was to keep every own-domain page
      // unjudged, on the reasoning that losing real own-site context is worse
      // than admitting one off-topic page. Live data says otherwise: when this
      // path ran it was the single largest source of junk in the book, because
      // "on their own domain" describes their help centre and their terms of
      // service as accurately as their launch blog. A page nobody judged is now
      // dropped. The dispatcher re-researches on cadence, so the cost of
      // dropping is one delayed pass; the cost of keeping was a permanent bad
      // fact the drafter reads forever.
      //
      // What is NOT free is dropping in silence, which is what this did until
      // 2026-08-14: the provider message is the difference between "top up the
      // account" and "the ceiling is too low", and it costs nothing to carry.
      return {
        chunk, keeps: [], drops: chunk.map((_, i) => ({ i, f: 'unreported' as GateRejectReason })),
        unreadable: true, omitted: 0, reason: gateFailureReason({ answered, text, finish, error: e }),
      };
    }
  }));

  const reasons = new Set<string>();
  for (const v of verdicts) {
    if (v.unreadable) { unreadable_batches += 1; if (v.reason) reasons.add(v.reason); }
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
    unreadable_reasons: [...reasons],
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
  if (!Number.isFinite(ageDays) || ageDays >= STRATEGY_STALE_DAYS) return false;
  // Angles are written FROM the questions, so a brief newer than the strategy
  // means these angles were planned against wording that has since changed.
  // orphanedAngles only catches a question that disappeared; a question that was
  // reworded keeps its id, and the angle built for the old wording goes on
  // running against the new one. Both planners already preserve ids, so this
  // costs one regeneration, not a reset.
  const briefAt = policy.research?.brief_generated_at;
  if (briefAt && Date.parse(briefAt) > Date.parse(at)) return false;
  return true;
}

/**
 * Stamp record_since on any angle whose search changed, and carry it forward on
 * any angle whose search did not. See ResearchAngle.record_since for why: the id
 * is kept across a rewrite so the record survives, which means without this a
 * rewritten query inherits the record of the query it replaced.
 */
export function stampRecordSince(next: ResearchAngle[], previous: ResearchAngle[], now = new Date().toISOString()): ResearchAngle[] {
  const before = new Map(previous.map((a) => [a.id, a]));
  return next.map((a) => {
    const p = before.get(a.id);
    const sameSearch = p && p.query_template === a.query_template && p.domain_scope === a.domain_scope;
    if (sameSearch) return p.record_since ? { ...a, record_since: p.record_since } : a;
    return { ...a, record_since: now };
  });
}

/**
 * Carry a human's off switch across a regeneration.
 *
 * `strategy` is a cache of AI-written angles, but `enabled` is not AI-written —
 * it is the one per-angle control a human has, and the header of this file has
 * promised it since the planner shipped. It was being thrown away every time:
 * `coerceAngle` sets `enabled: true` on everything it returns and the persist
 * replaces the whole array, so an angle a customer switched off came back on
 * within 14 days, in every workspace, with nothing in any log to say why.
 *
 * Only `false` is carried. An angle a human never touched has no stored intent to
 * preserve, and `unset` already means enabled.
 *
 * Deliberately survives a rewrite of the query. A human switching an angle off is
 * a decision about that angle, and the planner rewording its query is not new
 * information about whether the customer wanted it running.
 */
export function carryOffSwitch(next: ResearchAngle[], previous: ResearchAngle[]): ResearchAngle[] {
  const off = new Set(previous.filter((a) => a.enabled === false).map((a) => a.id));
  return next.map((a) => (off.has(a.id) ? { ...a, enabled: false } : a));
}

/**
 * Carry a human's PINNED searches across a regeneration, verbatim.
 *
 * The off switch above was the only human decision that survived a regeneration,
 * so a customer could stop a search but never keep one. That asymmetry is what
 * made a hand-written search for an uncovered question pointless: the next
 * regeneration deleted it and the question went back to having nothing looking
 * for it.
 *
 * A pinned angle is restored exactly as the human left it, including its query
 * and its record, and it wins over anything the planner returns under the same
 * id — the planner's rewrite is precisely what the pin exists to refuse.
 * Pinned angles are appended rather than counted against MAX_PLANNED_ANGLES,
 * because the cap is a budget decision about the planner's guesses and this is
 * not a guess.
 */
export function carryPinnedAngles(next: ResearchAngle[], previous: ResearchAngle[]): ResearchAngle[] {
  const pinned = previous.filter((a) => a.pinned);
  if (!pinned.length) return next;
  const pinnedIds = new Set(pinned.map((a) => a.id));
  return [...next.filter((a) => !pinnedIds.has(a.id)), ...pinned];
}

/** Merge an angle set onto workspaces.policy.research.strategy (cache write, not user config). */
export async function persistResearchStrategy(
  supabase: SupabaseClient,
  workspace_id: string,
  angles: ResearchAngle[],
): Promise<void> {
  const r = await supabase.from('workspaces').select('policy').eq('id', workspace_id).maybeSingle();
  const policy = (r.data?.policy ?? {}) as WorkspacePolicy;
  const now = new Date().toISOString();
  const research = { ...(policy.research ?? {}) };
  // Deleted rather than set to undefined: the policy is serialised to JSONB, and
  // relying on JSON.stringify to drop an undefined key is the kind of thing that
  // works until a caller reads the object before it round-trips.
  delete research.strategy_last_error;
  const next = {
    ...policy,
    research: {
      ...research,
      // Pins go on LAST so a pinned angle survives whatever the planner said
      // about the same id. stampRecordSince would otherwise treat the planner's
      // rewrite as the current query and restart the pinned angle's record.
      strategy: carryPinnedAngles(
        carryOffSwitch(stampRecordSince(angles, policy.research?.strategy ?? []), policy.research?.strategy ?? []),
        policy.research?.strategy ?? [],
      ),
      strategy_generated_at: now,
      // Both stamps move on success, so the floor is the same either way and
      // "generated" and "attempted" only ever diverge while the planner is down.
      strategy_attempted_at: now,
    },
  };
  await supabase.from('workspaces').update({ policy: next }).eq('id', workspace_id);
  invalidatePolicyCache(workspace_id);
}

/**
 * Record a planner attempt that fell back to BASELINE_ANGLES, WITHOUT touching
 * the stored angles or `strategy_generated_at`.
 *
 * The old shape re-persisted the stored angles purely to move the timestamp,
 * which held the retry floor and hid the failure in the same stroke. Splitting
 * the two stamps keeps the floor and leaves `strategy_generated_at` meaning what
 * it says. The error text is kept so the failure is legible from the policy
 * alone; the angles themselves are left exactly as they were.
 */
export async function recordStrategyAttempt(
  supabase: SupabaseClient,
  workspace_id: string,
  error?: string,
): Promise<void> {
  const r = await supabase.from('workspaces').select('policy').eq('id', workspace_id).maybeSingle();
  const policy = (r.data?.policy ?? {}) as WorkspacePolicy;
  const next = {
    ...policy,
    research: {
      ...(policy.research ?? {}),
      strategy_attempted_at: new Date().toISOString(),
      strategy_last_error: (error ?? 'planner fell back to the baseline').slice(0, 300),
    },
  };
  await supabase.from('workspaces').update({ policy: next }).eq('id', workspace_id);
  invalidatePolicyCache(workspace_id);
}

/**
 * Angles that have had a fair trial and are not earning their searches, by id.
 *
 * Held to `earnsItsSearches` — one answer per fair trial — rather than to zero.
 * Zero was the original bar because it needs no judgement, but it is also the
 * only number a single accident can move: the angle this was built for answered
 * its question once in 264 pages, and one lucky page made it permanently immune
 * to correction while it went on spending. One answer per 30 pages is still a
 * bar almost nothing real fails.
 *
 * Reads AngleRecord.kept, which counts only pages kept AS ANSWERING this angle's
 * question. The same angle kept 16 pages for other questions, so a check against
 * pages-kept-at-all would have called it healthy.
 *
 * Angles a human switched off are excluded — they are not running, so they are
 * not costing anything, and regenerating on their account would overrule the
 * human twice over.
 */
export function failedAngles(angles: ResearchAngle[], records: AngleRecord[]): string[] {
  const byId = new Map(records.map((r) => [r.id, r]));
  return angles
    .filter((a) => {
      if (a.enabled === false) return false;
      const r = byId.get(a.id);
      return !!r && r.fetched >= FAIR_TRIAL_PAGES && !earnsItsSearches(r);
    })
    .map((a) => a.id);
}

/**
 * Angles pointed at a brief question that is no longer in the brief.
 *
 * `answers` is set at plan time and checked against the brief that existed THEN.
 * The brief is regenerated on its own schedule, so a question can be reworded out
 * from under an angle that is still running, and the angle goes on buying pages
 * for something nothing is asking about any more. Free to check — the brief is
 * already on the policy in hand.
 *
 * Angles with no `answers` predate the brief and still run, so they are not
 * orphans.
 */
export function orphanedAngles(policy: WorkspacePolicy): string[] {
  const live = new Set(resolveBrief(policy).map((q) => q.id));
  return (policy.research?.strategy ?? [])
    .filter((a) => a.enabled !== false && a.answers && !live.has(a.answers))
    .map((a) => a.id);
}

/**
 * Questions nothing is buying pages for. The other direction of the check
 * above, and the one that was missing.
 *
 * `orphanedAngles` catches a search pointing at a question that no longer
 * exists. Nothing caught the reverse, and the planner is explicitly allowed to
 * leave a question uncovered when it judges that no search would find the
 * answer. So a question can be quietly abandoned and go on looking healthy
 * forever: it is still in the brief, the page filter still offers it as an
 * answer, the extractor is still told to look for it, and its scorecard reads
 * near-zero — which the maintenance loop then reads as a failing question and
 * rewrites or drops, when nothing ever searched for it.
 *
 * Found live on Sudden: the question asking what a technical leader had said
 * about delivery costs had no angle at all, and the search named for it was
 * filed as answering the new-launch question instead.
 *
 * Deliberately NOT wired into the strategy-freshness test. Forcing a
 * regeneration would loop against a planner that has already decided it cannot
 * cover the question. This is for a human to see and overrule by pinning a
 * search, which is a judgement the planner should not get to make alone.
 */
export function uncoveredQuestions(policy: WorkspacePolicy): string[] {
  const covered = new Set(
    (policy.research?.strategy ?? [])
      .filter((a) => a.enabled !== false && a.answers)
      .map((a) => a.answers as string),
  );
  return resolveBrief(policy)
    .filter((q) => q.enabled !== false && !covered.has(q.id))
    // The pain question is appended to every brief by resolveBrief and is
    // deliberately not something you go searching for — it is noticed on a page
    // fetched for another reason. Reporting it would put a permanent false
    // alarm on every workspace, which is how a real alert stops being read.
    .filter((q) => q.id !== PAIN_QUESTION.id)
    .map((q) => q.id);
}

/**
 * Floor on how often evidence alone may force a regeneration.
 *
 * Regenerating rewrites the failing query, which resets its record_since, so its
 * record starts empty and it stops looking failed — the loop closes itself. This
 * floor covers the cases where it does not: the planner handing back the SAME
 * query, whose record carries forward and still reads as failed, and a planner
 * error landing on BASELINE_ANGLES, whose questions belong to the baseline brief
 * and so read as orphaned against a generated one. Both would otherwise
 * regenerate on every 4h tick. Worst case is two planner calls per workspace per
 * day.
 */
const MIN_REGEN_HOURS = 12;

/**
 * Hours since the planner last RAN, whether it worked or not.
 *
 * Reads the later of the two stamps so an older successful generation cannot
 * re-open the floor after a more recent failure, and so a workspace written
 * before `strategy_attempted_at` existed still floors on its generation stamp
 * instead of regenerating on the first tick after deploy.
 */
function sinceLastAttemptHours(policy: WorkspacePolicy): number {
  const stamps = [policy.research?.strategy_attempted_at, policy.research?.strategy_generated_at]
    .map((s) => Date.parse(s ?? ''))
    .filter((n) => Number.isFinite(n));
  if (!stamps.length) return Infinity;
  return (Date.now() - Math.max(...stamps)) / 3_600_000;
}

/**
 * Return a usable strategy, regenerating + persisting if the cached one is missing,
 * stale, or contradicted by what its angles actually bought. Called by the
 * dispatcher once per workspace per tick (every 4h).
 *
 * Age alone was the only staleness test, which meant a search that was provably
 * buying nothing kept running for up to 14 days: measured on one workspace, an
 * angle fetching 183 pages a day and keeping none, so roughly 2,500 pages thrown
 * away before anything looked at it again. The planner can now see what each
 * angle bought, so the useful question is not "how old is this" but "is any of it
 * demonstrably not working".
 *
 * The extra read is ordered last on purpose: a strategy inside MIN_REGEN_HOURS
 * returns without touching events, so most ticks cost exactly what they did
 * before.
 */
export async function ensureResearchStrategy(supabase: SupabaseClient, workspace_id: string): Promise<ResearchAngle[]> {
  const policy = await getPolicy(supabase, workspace_id);
  const stored = policy.research?.strategy ?? [];
  // The floor applies to every path that would call the planner, not just the
  // fresh-strategy one. While a failed attempt restamped `strategy_generated_at`
  // the stale and brief-newer paths were floored by accident, because the
  // restamp made the strategy look fresh again on the next tick. Now that only a
  // success moves that stamp, a workspace whose planner is down and whose brief
  // is newer than its strategy would call the planner on every 4h tick forever.
  // A workspace with no angles at all is exempt: it has nothing to run.
  if (stored.length && sinceLastAttemptHours(policy) < MIN_REGEN_HOURS) return resolveStrategy(policy);
  if (isStrategyFresh(policy)) {
    // Orphans are free to check (the brief is already in hand) so they go first
    // and usually save the read below. Both are evidence triggers, so both sit
    // under the floor — an orphan that regeneration cannot clear used to fire on
    // every tick.
    const failing = orphanedAngles(policy).length > 0
      || failedAngles(stored, await loadAngleRecords(supabase, workspace_id, stored)).length > 0;
    if (!failing) return resolveStrategy(policy);
  }
  const { angles, source, error } = await generateResearchStrategy(supabase, workspace_id);
  // A planner error lands on BASELINE_ANGLES, and persisting those over a working
  // strategy is worse than not regenerating at all: the baseline answers `moves`
  // and `buyers`, which no generated brief contains, so every angle in the
  // workspace would be buying pages for a question nobody is asking — and read as
  // orphaned, forcing the same failing regeneration again. The baseline is the
  // right answer for a workspace that has never had a strategy, not for one whose
  // planner call just timed out. Measured while proving the withholding rule: 1
  // planner run in 12 came back as a fallback.
  //
  // The attempt is recorded rather than the angles re-persisted. Re-persisting
  // was only ever a way to move the timestamp, and moving THAT timestamp is what
  // made nine days of planner failures read as a fresh regeneration.
  if (source === 'baseline' && stored.length) {
    try { await recordStrategyAttempt(supabase, workspace_id, error); } catch { /* keep using what is in hand */ }
    return resolveStrategy(policy);
  }
  try {
    await persistResearchStrategy(supabase, workspace_id, angles);
  } catch {
    // cache write failed — still return the freshly generated angles for this tick
  }
  // The off switch is applied to what is RETURNED as well as to what is stored.
  // The persist merges it, but this tick runs on the value in hand, so without
  // this an angle a human disabled would run once more on the tick that
  // regenerated it — the one tick where nobody would think to look.
  //
  // Read back through resolveStrategy rather than filtering here, so "which
  // angles run" has one definition and the empty case behaves the same either way.
  const merged = carryOffSwitch(angles, policy.research?.strategy ?? []);
  return resolveStrategy({ ...policy, research: { ...(policy.research ?? {}), strategy: merged } });
}
