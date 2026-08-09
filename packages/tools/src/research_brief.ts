/**
 * The research brief: the short list of questions this workspace needs answered
 * about a prospect before it can write to them.
 *
 * WHY THIS EXISTS. Research used to be four filters in series, each tuned on its
 * own, and only two of them had any idea what the workspace sells. The planner
 * knew. The page gate half-knew (it got the pain list). The enricher knew
 * nothing at all — it was told "extract atomic claims, go deep" — so it wrote
 * down a company's award shortlist, its subscription prices and its LinkedIn
 * follower growth with the same enthusiasm as its peak concurrent viewers.
 * Measured on the Sudden book: 795 research facts in a week across 488 distinct
 * predicates, and 79% of the 1233 predicates in the whole book used exactly once.
 * That is not a knowledge graph, it is a pile of strings, and nothing downstream
 * can ask a question of it.
 *
 * The fix is one artifact three stages read:
 *
 *   planner   writes one search per question (`ResearchAngle.answers`)
 *   gate      keeps a page only if it answers one, and records WHICH on the page
 *   extractor is told the questions and pulls answers to them, nothing else
 *
 * That is the whole mechanism. Fact names stay flat.
 *
 * An earlier version made a question's id a permanent prefix on every fact name
 * it produced. It had to be torn out. Welding stored data to a question's NAME
 * meant renaming or retiring a question orphaned every fact filed under it, so
 * the brief had to be frozen after its first generation — which is backwards,
 * because the first generation is one LLM pass over a description and is exactly
 * the thing that should be allowed to improve. Cutting the prefix is what lets
 * the brief change, and being allowed to change is what lets it get better.
 *
 * Where the junk reduction actually came from, measured: telling the extractor
 * the questions and saying extract nothing else. On four support-page URLs the
 * old prompt invented `airplay_apple_tv_recommendation` and `app_os_requirement`;
 * the brief-aware prompt extracted nothing, correctly. No naming scheme was
 * involved in that result.
 *
 * Vertical-neutral, same rule as the strategy planner: the questions are written
 * by the model from the workspace's own About, or fall back to BASELINE_BRIEF,
 * which asks only things every seller wants and names no industry.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { chatComplete } from '@agent-crm/primitives';
import { getPolicy } from './policy.ts';
import type { BriefQuestion, WorkspacePolicy } from './policy.ts';

// Same model as the strategy planner, for the same reason: it runs about once
// per workspace per fortnight and everything downstream is shaped by its output.
const BRIEF_MODEL = 'deepseek-v4-pro';
const MAX_QUESTIONS = 7;
const MIN_QUESTIONS = 3;

/**
 * A question id is a PERMANENT predicate namespace — every `scale.*` fact ever
 * written belongs to the question called `scale`. So unlike the search strategy,
 * which can be re-planned freely because its output is only queries, the brief
 * must not drift on a timer. Two consecutive generations from the same About
 * produced `vod_catalogue_scale` and then nothing of the kind, and had both been
 * persisted the facts under the first name would have been orphaned.
 *
 * The brief is therefore regenerated only when its INPUTS change, and a
 * regeneration is shown the previous questions and told to keep the id of
 * anything that still means the same thing.
 */
function briefInputHash(ctx: BriefContext): string {
  const parts = [
    ctx.about.trim(),
    ctx.guidance.trim(),
    [...ctx.always_include].sort().join('|'),
    [...ctx.pain_points].sort().join('|'),
    [...ctx.value_props].sort().join('|'),
  ].join('\u0000');
  // Small non-cryptographic hash; this only has to notice that the text changed.
  let h = 2166136261;
  for (let i = 0; i < parts.length; i++) {
    h ^= parts.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * Neutral fallback for a workspace that has described nothing yet, and the
 * landing spot on any planner error.
 *
 * Every question here is one a seller in any market wants answered, phrased
 * without naming an industry, a metric or a product category. `moves` and
 * `voice` are the two that can carry a dated trigger; the rest are standing
 * state, which is what a theme-led message is built from.
 */
export const BASELINE_BRIEF: BriefQuestion[] = [
  {
    id: 'moves',
    label: 'What they just did',
    question: 'What has this company done recently that changed something — shipped, launched, expanded, acquired, hired, published a number, or committed to a plan?',
    why: 'A dated action is the only thing a first message can honestly open on.',
    kind: 'event',
  },
  {
    id: 'scale',
    label: 'How big the operation is',
    question: 'What figures does this company publish about the size of its operation — customers, users, volume, revenue, headcount, or throughput?',
    why: 'Size decides whether the problem this seller solves is big enough for them to care.',
    kind: 'state',
  },
  {
    id: 'buyers',
    label: 'Who they serve',
    question: 'Who does this company sell to or serve, and which named customers or partners do they show off?',
    why: 'Who they serve tells you which of the seller\'s problems actually lands.',
    kind: 'state',
  },
  {
    id: 'stack',
    label: 'How they run',
    question: 'What does this company build on, run on, or buy from others to operate?',
    why: 'How they run today is what the seller would be changing, replacing or sitting beside.',
    kind: 'state',
  },
  {
    id: 'voice',
    label: 'What their people say',
    question: 'Has anyone who works there said something publicly about how the company operates, what it is working on, or what is hard about it?',
    why: 'A named person on the record is the most specific hook available, and the easiest to reply to.',
    kind: 'event',
  },
];

/**
 * Always available to the enricher regardless of the brief, because a stated
 * problem is what every outreach message is ultimately built on and no generated
 * question list should be able to switch it off. Deliberately NOT in
 * BASELINE_BRIEF: it is not something you go SEARCHING for, it is something you
 * notice on a page you fetched for another reason.
 */
export const PAIN_QUESTION: BriefQuestion = {
  id: 'pain',
  label: 'What is hard for them',
  question: 'What does this company say is difficult, expensive, manual, slow, or missing today?',
  why: 'A problem in their own words is the strongest thing a message can be about.',
  kind: 'state',
};

/**
 * Slug for a question id, which is also a permanent predicate namespace, so it
 * has to read as words. Cut on a word boundary, never mid-word: a hard slice at
 * 24 chars turned "recent cdn cost statements" into `recent_cdn_cost_statemen`,
 * which then prefixes every fact that question ever produces.
 */
function slugify(s: string, fallback: string): string {
  const words = s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const w of words) {
    if (out.length && [...out, w].join('_').length > 24) break;
    out.push(w);
  }
  return out.join('_').slice(0, 24).replace(/_+$/, '') || fallback;
}

/** Normalize one raw question from the model, or null if it is unusable. */
function coerceQuestion(raw: unknown, idx: number, used: Set<string>): BriefQuestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const question = typeof r.question === 'string' ? r.question.trim() : '';
  if (question.length < 10) return null;
  let id = slugify(typeof r.id === 'string' ? r.id : '', `q${idx}`);
  // `pain` is reserved — PAIN_QUESTION always occupies that namespace, and two
  // questions writing into `pain.*` would make the slot meaningless.
  if (id === PAIN_QUESTION.id) id = `${id}_${idx}`;
  while (used.has(id)) id = `${id}_${idx}`;
  used.add(id);
  return {
    id,
    label: typeof r.label === 'string' && r.label.trim() ? r.label.trim().slice(0, 48) : id,
    question: question.slice(0, 300),
    why: typeof r.why === 'string' ? r.why.trim().slice(0, 200) : '',
    kind: r.kind === 'event' ? 'event' : 'state',
    enabled: true,
  };
}

const SYS_PROMPT = `You write the RESEARCH BRIEF for an AI sales agent: the short list of questions it must answer about a prospect company before it is allowed to write to them.

The agent will run web searches to answer these questions, and will throw away every page that answers none of them. So the brief decides what the agent spends money on and what it ignores.

Return ${MIN_QUESTIONS} to ${MAX_QUESTIONS} questions. Fewer, sharper questions beat many overlapping ones.

WHAT MAKES A GOOD QUESTION:
- It is about the PROSPECT, and its answer differs from one prospect to the next. "What industry are they in?" is not a question — the agent already picked them for that.
- Knowing the answer changes what the message says, or whether it gets sent at all.
- A stranger reading the answer would be able to tell whether this seller has something worth saying to that company.
- At least ONE question must be answerable by something DATED that happened — that is the only thing a first message can honestly open on.
- At least ONE question must be about how the prospect currently operates the thing this seller would change, replace, or sit beside.
- Prefer questions whose answers are published numbers, named systems, named customers, or something a person there actually said. Avoid questions answered by adjectives.

DO NOT ASK A QUALIFYING QUESTION. This is the most common mistake and it wastes more money than every other mistake combined.

A qualifying question asks whether a company is the right KIND of company: what sort of business it is, which model it runs, whether it has the characteristic that makes it a candidate at all. Its answer is yes or no, it is the same yes or no for years, and it is written on the company's front page.

  QUALIFYING (never ask): "Does the company sell direct to consumers, or to other businesses?"
  RESEARCH (ask this):    "What has the company published about how much it sells, and when?"

  QUALIFYING (never ask): "Does the company operate its own delivery fleet?"
  RESEARCH (ask this):    "Which suppliers or systems has the company named as running its operation, and has that changed?"

A separate scoring step already decides whether a company qualifies, before research ever runs. Every company you are writing this brief for HAS ALREADY QUALIFIED. Asking again spends real money re-reading their homepage, and a page that answers a qualifying question is almost always a help-centre article, an FAQ or a pricing table — the exact pages this system wastes the most on today.

The test: if the answer would be the same next year, and a competitor in the same market would give the same answer, it is a qualifying question. Cut it.

ALSO DO NOT ASK:
- Anything about hiring or open roles. A separate connector covers that.
- Contact details, org charts, or who reports to whom.
- Anything answerable from the company's help centre, pricing page, terms of service, or app-store listing.

Each question has:
- "id": a short lowercase slug, one or two words joined by "_". This becomes the permanent name of the slot the answer is stored in, so make it a plain noun for the topic (not a verb phrase, not a question).
- "label": a short human title, under 6 words.
- "question": the question itself, in plain language, as you would ask a researcher.
- "why": one line on why this seller specifically cares about the answer.
- "kind": "event" if answering it requires something dated that happened, "state" if it describes how the company stands.

COVER WHAT THEY SELL AGAINST. Every problem the seller says it solves must be reachable by at least one question — a question whose answer would tell you whether that problem is real and growing at this prospect, and roughly how big it is. Go through their problems one at a time and check each has a question. A problem with no question is a problem the agent will never find evidence for.

ONE QUESTION MUST ASK, BROADLY, HOW MUCH. Almost every seller's problem scales with some quantity at the prospect: how many of the thing they handle, how much they move, how many people they serve, how fast that is growing. Ask for that quantity in the widest terms the prospect might have published, and let the answer be any unit they use.

Write it broad, and do not let a must-include topic narrow it. A must-include names the BEST version of the number; it is not the only version worth having. If the seller asks specifically for the peak of something, the brief needs BOTH a question for that peak AND a broader question for the plain running total — because the peak is published rarely and the total is published constantly, and a brief that only asks for the peak throws away every ordinary volume figure the company reports.

  TOO NARROW: "What is the largest number of X the company has reported at one time?"
  ALSO NEEDED: "What has the company published about its total X, and how fast is it growing?"

This is the single most common way a brief fails, and it fails silently: the agent keeps searching, keeps paying, and quietly discards the numbers that were right there.

Write the questions for THIS seller, from what they say about themselves below. Every must-include topic they list has to be covered by at least one question.

Return JSON only: {"questions":[{"id","label","question","why","kind"}]}`;

/**
 * What one question has earned, over some recent window. Passed into a
 * regeneration so the planner corrects the brief from evidence instead of
 * re-rolling the dice on the same About text.
 *
 * The three counts are kept apart on purpose — they diagnose different failures
 * and the wrong reading deletes a good question:
 *   fetched high / kept low  -> the SEARCH is wrong. Reword it, keep the question.
 *   kept high / facts 0      -> extraction problem, not a question problem.
 *   facts high / used 0      -> the question genuinely does not move a message.
 *
 * See scripts/research_scorecard.ts, which computes these from data already
 * stored (run markers, page records, facts, draft citations).
 */
export interface QuestionRecord {
  id: string;
  /** Pages the searches for this question brought back. */
  fetched: number;
  /** Of those, how many were kept as answering it. */
  kept: number;
  /** Facts read off the kept pages. */
  facts: number;
  /** Facts a draft actually cited. Sparse early on — see the guardrail below. */
  used: number;
}

/**
 * Below this many pages seen, a question has not had a fair trial and must not
 * be judged on its numbers. Without it the planner retires anything new, because
 * anything new looks like it produced nothing.
 */
const MIN_SAMPLE_FETCHED = 30;

export interface BriefContext {
  about: string;
  icp?: string;
  value_props: string[];
  pain_points: string[];
  guidance: string;
  always_include: string[];
}

function buildUserPayload(ctx: BriefContext): string {
  const parts: string[] = [];
  if (ctx.about) parts.push(`THE SELLER (who they are, what they sell, who they sell to):\n${ctx.about.slice(0, 2000)}`);
  if (ctx.icp && ctx.icp !== '{}') parts.push(`WHO THEY TARGET (structured):\n${ctx.icp}`);
  if (ctx.value_props.length) parts.push(`WHAT THEIR PRODUCT DOES:\n- ${ctx.value_props.slice(0, 8).join('\n- ')}`);
  if (ctx.pain_points.length) parts.push(`PROBLEMS THEY SOLVE FOR CUSTOMERS:\n- ${ctx.pain_points.slice(0, 8).join('\n- ')}`);
  if (ctx.guidance) parts.push(`OPERATOR GUIDANCE (what they told the agent to dig up):\n${ctx.guidance.slice(0, 1500)}`);
  if (ctx.always_include.length) parts.push(`MUST-COVER topics (each needs >=1 question):\n- ${ctx.always_include.join('\n- ')}`);
  return parts.join('\n\n') || '(nothing provided — produce a neutral, universal brief)';
}

/** Plan a brief from an already-built context. No DB read, no write. */
export async function planResearchBrief(
  ctx: BriefContext,
  opts?: { model?: string; previous?: BriefQuestion[]; records?: QuestionRecord[] },
): Promise<{ questions: BriefQuestion[]; source: 'ai' | 'baseline'; error?: string }> {
  if (!ctx.about && !ctx.guidance && !ctx.always_include.length && !ctx.value_props.length) {
    return { questions: BASELINE_BRIEF, source: 'baseline' };
  }
  const previous = (opts?.previous ?? []).filter((q) => q?.id && q?.question);
  const records = new Map((opts?.records ?? []).map((r) => [r.id, r]));
  const recordLine = (q: BriefQuestion): string => {
    const r = records.get(q.id);
    if (!r) return '';
    if (r.fetched < MIN_SAMPLE_FETCHED) return `  [only ${r.fetched} pages seen so far — TOO EARLY TO JUDGE, keep it]`;
    const hit = r.fetched ? Math.round((r.kept / r.fetched) * 100) : 0;
    const parts = [`${r.fetched} pages seen, ${r.kept} kept (${hit}%)`, `${r.facts} facts`, `${r.used} used in a message`];
    let read: string;
    if (hit < 10) read = 'the SEARCH is finding the wrong pages — rewrite its query, do NOT drop the question';
    else if (r.kept >= 5 && r.facts === 0) read = 'right pages, nothing being read off them — keep the question';
    else if (r.facts >= 10 && r.used === 0) read = 'produces facts no message has ever used — a candidate to drop';
    else read = 'earning its place — keep it, and keep its wording close';
    return `  [${parts.join(', ')} -> ${read}]`;
  };
  // Every id kept is a slot of already-extracted facts that stays readable.
  const continuityBlock = previous.length
    ? `\n\nTHERE IS ALREADY A BRIEF IN PLACE, AND A RECORD OF WHAT EACH QUESTION HAS EARNED.

Keep the id EXACTLY as written for any question you keep, even if you reword the question itself — a question's track record is filed under its id, and a renamed id starts that record from zero. Invent a new id only for a genuinely new question.

Read the record before you change anything. A question that has found little is USUALLY a badly worded search, not a bad question, and rewriting the question throws away the one thing that was working. Drop a question only when it has had a fair trial AND produces facts no message ever uses.

${previous.map((q) => `  ${q.id} — ${q.question}\n${recordLine(q)}`).join('\n')}`
    : '';
  try {
    const llm = await chatComplete({
      model: opts?.model ?? BRIEF_MODEL,
      max_tokens: 1600,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYS_PROMPT },
        { role: 'user', content: `${buildUserPayload(ctx)}${continuityBlock}` },
      ],
    });
    const parsed = JSON.parse(llm.text) as { questions?: unknown[] };
    const used = new Set<string>();
    const questions: BriefQuestion[] = [];
    for (const [i, raw] of (parsed.questions ?? []).entries()) {
      const q = coerceQuestion(raw, i, used);
      if (q) questions.push(q);
      if (questions.length >= MAX_QUESTIONS) break;
    }
    if (questions.length < MIN_QUESTIONS) {
      return { questions: BASELINE_BRIEF, source: 'baseline', error: `planner returned ${questions.length} valid questions` };
    }
    return { questions, source: 'ai' };
  } catch (e) {
    return { questions: BASELINE_BRIEF, source: 'baseline', error: e instanceof Error ? e.message : String(e) };
  }
}

async function loadContext(supabase: SupabaseClient, workspace_id: string): Promise<BriefContext> {
  const policy = await getPolicy(supabase, workspace_id);
  const w = await supabase.from('workspaces').select('about, icp').eq('id', workspace_id).maybeSingle();
  const icpObj = (w.data?.icp ?? {}) as Record<string, unknown>;
  return {
    about: (w.data?.about as string | null)?.trim() ?? '',
    icp: typeof icpObj === 'object' ? JSON.stringify(icpObj).slice(0, 1500) : '',
    value_props: (policy.drafter?.value_props ?? []).filter(Boolean),
    pain_points: (policy.drafter?.pain_points ?? []).filter(Boolean),
    guidance: (policy.research?.guidance ?? '').trim(),
    always_include: (policy.research?.always_include ?? []).filter(Boolean),
  };
}

/** Build a brief from the workspace's persisted About/ICP/policy. Pure: no write. */
export async function generateResearchBrief(
  supabase: SupabaseClient,
  workspace_id: string,
  opts?: { model?: string; records?: QuestionRecord[] },
): Promise<{ questions: BriefQuestion[]; source: 'ai' | 'baseline'; error?: string }> {
  let ctx: BriefContext;
  try {
    ctx = await loadContext(supabase, workspace_id);
  } catch (e) {
    return { questions: BASELINE_BRIEF, source: 'baseline', error: e instanceof Error ? e.message : String(e) };
  }
  const policy = await getPolicy(supabase, workspace_id).catch(() => ({} as WorkspacePolicy));
  return planResearchBrief(ctx, { ...opts, previous: policy.research?.brief ?? [] });
}

/** The input hash for a workspace, so a caller that persists can store it. */
export async function briefInputHashFor(supabase: SupabaseClient, workspace_id: string): Promise<string | undefined> {
  try { return briefInputHash(await loadContext(supabase, workspace_id)); } catch { return undefined; }
}

/**
 * The brief the runtime should use: cached questions off policy, baseline if
 * there are none. `pain` is appended by every caller that needs it rather than
 * stored, so it can never be edited away in the settings UI.
 */
export function resolveBrief(policy: WorkspacePolicy): BriefQuestion[] {
  const stored = (policy.research?.brief ?? []).filter(
    (q) => q && q.enabled !== false && typeof q.id === 'string' && q.id && typeof q.question === 'string' && q.question.trim().length > 0,
  );
  const brief = stored.length ? stored : BASELINE_BRIEF;
  // PAIN_QUESTION is appended here, for every caller, rather than offered as a
  // separate "with pain" reader. There was briefly one of each, and the gate
  // ended up on the version without it — so a page reporting that a company's
  // service had buckled under load answered no question and was dropped, which
  // is the most valuable page there is. One reader, one answer, no way to pick
  // the wrong one.
  return brief.some((q) => q.id === PAIN_QUESTION.id) ? brief : [...brief, PAIN_QUESTION];
}

/**
 * A stored brief stays in force until the workspace's own description changes.
 * Deliberately NOT a time-based staleness check like the search strategy uses:
 * re-planning a query costs nothing, but re-planning a question renames a
 * predicate namespace and orphans every fact filed under the old name.
 */
function isBriefCurrent(policy: WorkspacePolicy, ctx: BriefContext): boolean {
  if (!(policy.research?.brief ?? []).length) return false;
  const stored = policy.research?.brief_input_hash;
  // A brief saved before hashing existed has no hash. Keep it — the questions
  // are in use and silently regenerating them is the exact harm this guards.
  if (!stored) return true;
  return stored === briefInputHash(ctx);
}

/** Merge a brief onto workspaces.policy.research.brief (cache write, not user config). */
export async function persistResearchBrief(
  supabase: SupabaseClient,
  workspace_id: string,
  questions: BriefQuestion[],
  input_hash?: string,
): Promise<void> {
  const r = await supabase.from('workspaces').select('policy').eq('id', workspace_id).maybeSingle();
  const policy = (r.data?.policy ?? {}) as WorkspacePolicy;
  const next = {
    ...policy,
    research: {
      ...(policy.research ?? {}),
      brief: questions,
      brief_generated_at: new Date().toISOString(),
      ...(input_hash ? { brief_input_hash: input_hash } : {}),
    },
  };
  await supabase.from('workspaces').update({ policy: next }).eq('id', workspace_id);
}

/**
 * Return a usable brief, regenerating + persisting when the cached one is
 * missing or stale. Called by the dispatcher once per workspace per tick, so the
 * runner and the enricher only ever read the cache.
 */
export async function ensureResearchBrief(supabase: SupabaseClient, workspace_id: string, records?: QuestionRecord[]): Promise<BriefQuestion[]> {
  const policy = await getPolicy(supabase, workspace_id);
  let ctx: BriefContext;
  try {
    ctx = await loadContext(supabase, workspace_id);
  } catch {
    return resolveBrief(policy); // cannot tell if it changed — keep what is stored
  }
  if (isBriefCurrent(policy, ctx)) return resolveBrief(policy);
  const { questions } = await planResearchBrief(ctx, { previous: policy.research?.brief ?? [], records });
  try {
    await persistResearchBrief(supabase, workspace_id, questions, briefInputHash(ctx));
  } catch {
    // cache write failed — still use the freshly generated brief this tick
  }
  return questions;
}

/**
 * Render the brief for a prompt. One line per question, numbered, with the
 * slot name the answer must be stored under.
 */
export function renderBrief(questions: BriefQuestion[], opts?: { withWhy?: boolean }): string {
  return questions
    .map((q) => {
      const why = opts?.withWhy && q.why ? `\n     why it matters: ${q.why}` : '';
      return `  [${q.id}] ${q.question}${why}`;
    })
    .join('\n');
}
