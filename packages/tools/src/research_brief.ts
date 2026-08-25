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
import { getPolicy } from './policy.ts';
import { chatCompleteForWorkspace } from './chat_workspace.ts';
import { fetchAll } from './paginate.ts';
import type { BriefQuestion, WorkspacePolicy, DrafterArgument } from './policy.ts';

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
export function briefInputHash(ctx: BriefContext): string {
  const parts = [
    ctx.about.trim(),
    ctx.guidance.trim(),
    [...ctx.always_include].sort().join('|'),
    [...ctx.pain_points].sort().join('|'),
    [...ctx.value_props].sort().join('|'),
    // The floor shapes the questions (see BriefContext.max_age_days), so moving
    // it has to re-open the brief. Without this, narrowing the floor leaves every
    // question still asking for a window the pipeline no longer reaches.
    String(ctx.max_age_days ?? ''),
    // Editing an argument has to re-open the brief for the same reason. The
    // questions exist to find what the arguments need, so changing what you
    // argue while leaving the brief alone means the agent keeps researching for
    // the argument you dropped and never looks for what the new one requires.
    (ctx.arguments ?? []).map((a) => `${a.id}:${a.when}:${a.only_if ?? ''}:${a.so}`).sort().join('|'),
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
    // Which argument's condition this question establishes, when the planner
    // said so. Carried through because it decides whether the question is
    // protected from retirement, and a protection that the planner can claim
    // but the parser drops is no protection at all.
    ...(typeof r.serves === 'string' && r.serves.trim() ? { serves: slugify(r.serves, '') } : {}),
    enabled: true,
  };
}

// Interpolated, not a literal, for the same reason the strategy planner
// interpolates it: a prompt that states a different number than the workspace's
// real policy.research.max_age_days teaches the planner to write questions whose
// answers get binned on arrival. DEFAULT is only the fallback when unset.
const DEFAULT_PROMPT_FLOOR_DAYS = 90;
export const sysPrompt = (floorDays = DEFAULT_PROMPT_FLOOR_DAYS) => `You write the RESEARCH BRIEF for an AI sales agent: the short list of questions it must answer about a prospect company before it is allowed to write to them.

The agent will run web searches to answer these questions, and will throw away every page that answers none of them. So the brief decides what the agent spends money on and what it ignores.

Return ${MIN_QUESTIONS} to ${MAX_QUESTIONS} questions. Fewer, sharper questions beat many overlapping ones.

WHAT MAKES A GOOD QUESTION:
- It is about the PROSPECT, and its answer differs from one prospect to the next. "What industry are they in?" is not a question — the agent already picked them for that.
- Knowing the answer changes what the message says, or whether it gets sent at all.
- A stranger reading the answer would be able to tell whether this seller has something worth saying to that company.
- At least ONE question must be about how the prospect currently operates the thing this seller would change, replace, or sit beside.
- Prefer questions whose answers are published numbers, named systems, named customers, or something a person there actually said. Avoid questions answered by adjectives.

MOST OF YOUR QUESTIONS MUST ASK WHAT HAPPENED, NOT WHAT IS TRUE.

The agent is only allowed to write to a company when it holds a fact about something that HAPPENED on a knowable date, recently. A fact with no date is thrown out before a message is written, however true and however interesting it is. So a question whose answers have no dates on them cannot make a single account writable, no matter how well its searches work or how much the agent learns from it.

This is measured, per question, and you are shown the result below. A brief that fails here fails silently in the worst way: searches run, pages are kept, facts pile up, and the agent still has nothing to say to anybody.

  NO DATE (cannot open a message): "Which delivery providers does the company use?"
  DATED   (can open a message):    "What has the company changed, launched or moved to recently, and when?"

  NO DATE: "How does the company make money?"
  DATED:   "What has the company announced about a new pricing tier, plan or ad product, and when?"

Both of a pair can be about the same subject. The difference is entirely whether the answer comes with a date attached, and that difference decides whether the agent can act on it.

So: at least HALF your questions must be ones a dated answer is the natural answer to, and mark those "event". Do not settle for one. If the single event question you wrote turns out to be unsearchable for a given seller, a brief with only one has left the agent unable to write to anyone at all, which is exactly what has happened in production.

Keep some "state" questions too — how a company operates, and what it says is hard or expensive today, are what make a message worth reading once it has a reason to exist. They are just never the reason itself.

DO NOT ASK A QUALIFYING QUESTION. This is the most common mistake and it wastes more money than every other mistake combined.

A qualifying question asks whether a company is the right KIND of company: what sort of business it is, which model it runs, whether it has the characteristic that makes it a candidate at all. Its answer is yes or no, it is the same yes or no for years, and it is written on the company's front page.

  QUALIFYING (never ask): "Does the company sell direct to consumers, or to other businesses?"
  RESEARCH (ask this):    "What has the company published about how much it sells, and when?"

  QUALIFYING (never ask): "Does the company operate its own delivery fleet?"
  RESEARCH (ask this):    "Which suppliers or systems has the company named as running its operation, and has that changed?"

A separate scoring step already decides whether a company qualifies, before research ever runs. Every company you are writing this brief for HAS ALREADY QUALIFIED. Asking again spends real money re-reading their homepage, and a page that answers a qualifying question is almost always a help-centre article, an FAQ or a pricing table — the exact pages this system wastes the most on today.

The test: if the answer would be the same next year, and a competitor in the same market would give the same answer, it is a qualifying question. Cut it.

DO NOT WRITE A TIME WINDOW THE PIPELINE CANNOT REACH. Anything published more than ${floorDays} days ago is thrown away on arrival, so a question asking what someone said "in the past year" or "in the last six months" is asking for pages that are binned before anything reads them. The search built for it then finds nothing, run after run, and the question reads as a failing search when it was never reachable. Either keep the window inside ${floorDays} days or write the question without a window at all.

ALSO DO NOT ASK:
- Anything about hiring or open roles. A separate connector covers that.
- Contact details, org charts, or who reports to whom.
- Anything answerable from the company's help centre, pricing page, terms of service, or app-store listing.

Each question has:
- "id": a short lowercase slug, one or two words joined by "_". This becomes the permanent name of the slot the answer is stored in, so make it a plain noun for the topic (not a verb phrase, not a question).
- "label": a short human title, under 6 words.
- "question": the question itself, in plain language, as you would ask a researcher.
- "why": one line on why this seller specifically cares about the answer.
- "kind": "event" if answering it requires something dated that happened, "state" if it describes how the company stands. This is a promise you are held to: every "event" question is measured on what share of its facts carry a real date, and one that does not deliver them is reported back to you as failing. Do not mark a question "event" to satisfy the rule above when its honest answer is a description.

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
export interface QuestionSearchRecord {
  id: string;
  /** Pages the searches for this question brought back. */
  fetched: number;
  /** Of those, how many were kept as answering it. */
  kept: number;
}

export interface QuestionRecord extends QuestionSearchRecord {
  /** Facts read off the kept pages. */
  facts: number;
  /**
   * Of those facts, how many record something that happened on a knowable date.
   *
   * This is the column the loop was missing, and it is the only one that maps to
   * whether the agent can write at all. A message needs an anchor, an anchor is a
   * dated fact inside the freshness window, and an undated fact is rejected by
   * pickAnchorCandidates as not_an_event however true and however useful it is.
   * So a question can keep pages, produce facts, and read as healthy on every
   * other number here while never once making an account writable.
   *
   * Measured on Sudden over 60 days when this was added: the workspace had 90
   * writable accounts out of 1,961, and ONE question produced 88 of them.
   * monetization_model had bought 250 searches and produced 212 facts, of which
   * 19 were dated, reaching 10 accounts — and the scorecard called it "earning
   * its place", correctly by the old bar, which is the problem.
   */
  dated: number;
  /** Facts a draft actually cited. Sparse early on — see the guardrail below. */
  used: number;
  /**
   * What the brief SAID this question would produce, from its own `kind` field.
   *
   * The planner has always declared this per question and until now nothing read
   * it, so a question could promise dated events, deliver none, and never be
   * told. A 'state' question is not expected to produce dates and must never be
   * judged on them: `pain` is a state question, it is the most valuable thing
   * research finds, and a date bar applied to it would delete it.
   */
  kind: 'event' | 'state';
}

/**
 * Below this many pages seen, a search has not had a fair trial and must not be
 * judged on its numbers. Without it the planner retires anything new, because
 * anything new looks like it produced nothing.
 *
 * One definition for the whole loop. `research_strategy.ts` judges a single
 * angle against it and `research_scorecard.ts` prints against it; they each kept
 * their own copy of the number, which is how two parts of the same loop can
 * quietly start disagreeing about whether a search has been given a chance.
 */
export const FAIR_TRIAL_PAGES = 30;

/**
 * How often a search has to answer its own question to be worth buying: 3% of
 * the pages it brings back.
 *
 * A judgement call, and worth saying so plainly rather than dressing it up. This
 * was first written as `kept * FAIR_TRIAL_PAGES >= fetched`, which reads as
 * though the threshold follows from the fair-trial sample size. It does not. A
 * sample size and a rate are unrelated quantities, and reusing one constant for
 * both bought nothing except a sentence that sounded derived. The number is
 * fitted to one workspace's four angles: the one earning its place runs at 6%,
 * the two being condemned at 0.4%.
 *
 * Code rather than workspace policy, deliberately. It does not vary by customer
 * or by vertical, and nobody could pick it from a settings page with any idea
 * what they were choosing. Threading it through the four call sites as an
 * optional argument is precisely how the last feedback loop in this file died.
 */
export const MIN_ANSWER_RATE = 0.03;

/**
 * THE BAR, and the only one: a search has to answer the question it was bought
 * for often enough to be worth the pages.
 *
 * One test read at both altitudes, which is the point. Applied to ONE angle it
 * means "this query is not working, write a different one". Applied to a QUESTION
 * across every query ever pointed at it, it means something the loop could not
 * previously conclude at all: no search answers this, so stop buying them.
 *
 * Deliberately not "kept === 0". An angle sitting at one lucky page in 264 was
 * immune to correction under a zero test, because zero is the only number a
 * single accident can move.
 */
export function earnsItsSearches(r: { fetched: number; kept: number }): boolean {
  return r.kept >= r.fetched * MIN_ANSWER_RATE;
}

/**
 * How much of what an event question produces has to be genuinely dated: a fifth.
 *
 * Fitted the same way MIN_ANSWER_RATE was, and worth stating as plainly. On
 * Sudden's 60-day record the one event question that works runs at 51% dated and
 * produces 88 of the workspace's 90 writable accounts. The questions that produce
 * facts nobody can open on run at 0%, 8%, 9% and 10%. There is a wide empty gap
 * between 10% and 51% and this sits in it.
 *
 * Deliberately not "any dated fact at all". A question that lands one dated fact
 * in 200 is immune to correction under a zero test, for the same reason
 * earnsItsSearches is not written as `kept === 0`.
 */
export const MIN_DATED_RATE = 0.2;

/**
 * Facts needed before the date share means anything.
 *
 * A separate number from FAIR_TRIAL_PAGES because it counts a different thing: a
 * question can see plenty of pages and produce few facts, and judging a date
 * share off three facts is judging noise. 20 is roughly where one unlucky run
 * stops being able to move the verdict on its own.
 */
export const MIN_FACTS_FOR_DATE_VERDICT = 20;

/**
 * Does what this question buys ever let the agent write to anybody?
 *
 * The bar the loop did not have. Every other measure here asks whether research
 * found ANYTHING; this asks whether what it found can become a message. A fact
 * with no date cannot: pickAnchorCandidates rejects it as not_an_event, so a
 * question producing only undated facts adds nothing to whether the agent can
 * write, however true and however interesting its answers are.
 *
 * It keys off SPEND, not off the question's declared kind, and that is the whole
 * design. The first version judged only questions marked 'event', which read
 * well and let the largest waste on the book straight through: Sudden's
 * `monetization_model` is declared 'state', had bought 1,590 pages — more than
 * any other question — and returned 19 dated facts across 10 accounts. Labelling
 * a question as a description does not make the searches free.
 *
 * Three ways to pass, and the exemptions matter more than the threshold:
 *
 *   1. It buys nothing. A question with no searches pointed at it costs nothing
 *      and is answered on pages bought for other questions. `pain` is the case
 *      that proves it: nobody searches for pain, its answers are undated by
 *      nature, and it is the most valuable thing research finds. A bar that
 *      condemned it would delete the best question in the brief.
 *   2. Too few facts to judge. Same shape as the fair-trial rule — a new
 *      question has produced nothing yet and that is not a failure.
 *   3. It produces dated facts, OR facts that messages actually cite. The second
 *      half is what keeps an honest description question alive: knowing how a
 *      company operates is never the REASON to write, but it is often what makes
 *      the message worth reading, and a question doing that job is earning its
 *      pages even with no dates at all.
 *
 * True whenever there is not enough evidence, so this can never condemn a
 * question for being new.
 */
export function makesAccountsWritable(r: {
  fetched: number;
  facts: number;
  dated: number;
  used: number;
  serves_precondition?: boolean;
}): boolean {
  if (r.fetched < FAIR_TRIAL_PAGES) return true;
  if (r.facts < MIN_FACTS_FOR_DATE_VERDICT) return true;
  // A question establishing an argument's condition is judged by a test it can
  // never pass, and this loop has already failed it once. A condition is never
  // quoted in a message — its whole job is to decide whether the message may be
  // written at all — and it is rarely an event, so it scores zero on citations
  // and zero on dates while being the thing an argument depends on.
  //
  // `catalogue_size` was retired from Sudden's brief on exactly those numbers,
  // 16 facts and no citations, and it is the condition for the only argument
  // that workspace has. Measured after it was gone: 90 accounts held a fresh
  // anchor, 59 held any evidence of a catalogue, 27 held both. The loop deleted
  // the question that would have closed that gap and reported it as tidying up.
  if (r.serves_precondition) return true;
  if (r.used > 0 && r.used >= r.facts * MIN_ANSWER_RATE) return true;
  return r.dated >= r.facts * MIN_DATED_RATE;
}

/**
 * How many fair trials a question gets before the verdict moves from "the search
 * is wrong" to "no search can answer this".
 *
 * A failing angle forces a rewrite every fair trial (see failedAngles), so by
 * this point the planner has had roughly five goes at writing a search for the
 * question and the pages bought have still not answered it. Five is a judgement
 * call; that it is several, and that a human can read the count off the
 * scorecard, is the part that matters.
 */
export const UNREACHABLE_TRIALS = 5;
export const UNREACHABLE_PAGES = FAIR_TRIAL_PAGES * UNREACHABLE_TRIALS;

/**
 * How far back this one verdict looks, and why it is not RECORD_WINDOW_DAYS.
 *
 * 30 days is right for "is this search working", which is a question about the
 * search running now. It is the wrong window for "can this question ever be
 * answered", because that needs 150 pages inside it — about 5 pages a day for one
 * question. Sudden's failing question runs at 9 a day and gets there. A workspace
 * researching a few accounts a week never would, so the loop it is meant to end
 * would run forever on exactly the workspaces least able to afford it.
 *
 * 90 days brings the bar down to under 2 pages a day. Below that the honest
 * answer is that there is no evidence yet: a verdict drawn from 20 pages is a
 * guess, and this measure has already produced one false positive from a
 * denominator that did not line up. A workspace that quiet is also spending a few
 * dollars a year on the question, so waiting costs it almost nothing.
 */
export const UNREACHABLE_WINDOW_DAYS = 90;

/**
 * Questions no web search can answer — the exit the loop did not have.
 *
 * Without this the correction cycle cannot terminate. A failing angle is
 * rewritten, the rewrite resets that angle's record, the fresh record reads
 * "too early to judge", and the same question is searched for again forever. The
 * brief planner cannot break the tie either: it is told, correctly, that a low
 * hit rate means the SEARCH is wrong and never the question. Both readings are
 * right per attempt and neither can look across attempts. Measured on one
 * workspace: a question rewritten twice, 264 pages bought, answered once.
 *
 * What happens to a question that lands here is NOT retirement, and the
 * difference is the whole design. It stays in the brief, so the gate keeps
 * checking pages against it and the enricher keeps filling its slot — it simply
 * stops having searches bought for it. That is exactly how the always-on `pain`
 * question already works, and pain is the single most valuable thing research
 * finds: nobody searches for it, it is noticed on a page fetched for something
 * else. "Cannot be searched for" and "not worth knowing" are different facts,
 * and conflating them deletes the best question in the brief.
 *
 * Reversible for free and on its own. The count is derived from a rolling
 * window, so a question here drifts back out of it once its old spend ages off,
 * and the planner gets to try again — roughly one 150-page probe a month per
 * dead question, which is the right price for noticing that the web changed. And
 * if the gate files any page under it in the meantime, from a search bought for
 * some other question, the bar is met and it comes back immediately.
 */
export function unreachableQuestions(records: QuestionSearchRecord[]): string[] {
  return records.filter((r) => r.fetched >= UNREACHABLE_PAGES && !earnsItsSearches(r)).map((r) => r.id);
}

/**
 * One question's numbers, and what the planner should do about them, as the line
 * the planner reads.
 *
 * A module-level function rather than a closure inside the prompt builder,
 * because this sentence is the whole feedback loop: the columns diagnose
 * DIFFERENT failures, and the wrong reading of the same four numbers deletes a
 * good question or spends forever on an impossible one. It is worth being able to
 * assert on directly.
 */
export function recordReading(r: QuestionRecord): string {
  if (r.fetched < FAIR_TRIAL_PAGES) return `  [only ${r.fetched} pages seen so far — TOO EARLY TO JUDGE, keep it]`;
  const hit = r.fetched ? Math.round((r.kept / r.fetched) * 100) : 0;
  const datedPct = r.facts ? Math.round((r.dated / r.facts) * 100) : 0;
  const parts = [
    `${r.fetched} pages seen, ${r.kept} kept (${hit}%)`,
    `${r.facts} facts, ${r.dated} of them dated (${datedPct}%)`,
    `${r.used} used in a message`,
  ];
  let read: string;
  if (r.fetched >= UNREACHABLE_PAGES && !earnsItsSearches(r)) {
    read = 'searching for this does not work — several different searches have now been tried and the pages they bought do not answer it. Searches for it have been STOPPED. KEEP the question anyway and keep its wording: pages bought for the other questions are still read against it, which is how the most valuable answers arrive';
  } else if (!earnsItsSearches(r)) read = 'the SEARCH is finding the wrong pages — rewrite its query, do NOT drop the question';
  else if (r.kept >= 5 && r.facts === 0) read = 'right pages, nothing being read off them — keep the question';
  // Read before the used===0 line, because it explains it. A question producing
  // undated facts produces facts no message CAN use, and the fix is not to drop
  // the question — it is to ask for the same subject as something that happened.
  else if (!makesAccountsWritable(r)) {
    read = `${100 - datedPct}% of what this finds has NO DATE on it, and it has bought ${r.fetched} pages to get there${r.kind === 'event' ? ', despite being written as a question about something that happened' : ''}. An undated fact cannot open a message, so this question is not making a single account writable. REWRITE it to ask what the company DID and WHEN — the event behind the same subject, not the standing description of it. Keep the id`;
  } else if (r.facts >= 10 && r.used === 0) read = 'produces facts no message has ever used — a candidate to drop';
  else read = 'earning its place — keep it, and keep its wording close';
  return `  [${parts.join(', ')} -> ${read}]`;
}

export interface BriefContext {
  about: string;
  icp?: string;
  value_props: string[];
  pain_points: string[];
  /**
   * policy.drafter.arguments. What the research is FOR.
   *
   * Before this, the brief was planned from a description of the seller and the
   * drafter was left to work out what any of it meant, so the two halves of the
   * loop optimised for different things: research chased anything dated, the
   * drafter chased anything plausible, and neither chased "we have a reason to
   * make our actual argument to this account". Sudden's one working question
   * happened to serve its one real argument by luck.
   */
  arguments?: DrafterArgument[];
  guidance: string;
  always_include: string[];
  /**
   * policy.research.max_age_days — the workspace's ingestion floor.
   *
   * The strategy planner has been told this for a while, because an angle wider
   * than the floor buys results the runner bins. The brief planner was not, and
   * it writes the questions the angles are built from: it asked what a technical
   * leader had said "in the past year" against a 90-day floor, so the only pages
   * that could answer it were binned on arrival. The search then read as broken
   * for 183 pages when the question was never reachable.
   */
  max_age_days?: number;
}

/** Exported for scripts/check_research_brief.ts: the argument block is the only
 * thing telling the planner to write a question for an argument's condition, and
 * a planner that is never told writes the trigger question alone. */
export function buildUserPayload(ctx: BriefContext): string {
  const parts: string[] = [];
  // The arguments come FIRST when there are any, because they are the reason
  // the research exists. Every other block below describes the seller; this one
  // says what the agent has to find before it is allowed to say anything, which
  // makes it the only block that decides whether a question is worth buying.
  if (ctx.arguments?.length) {
    parts.push(`THE ARGUMENTS THIS SELLER MAKES — the research exists to find what these need, and nothing else here matters as much:\n${
      ctx.arguments.map((a) => [
        `- ${a.id}`,
        `    fires when : ${a.when}`,
        ...(a.only_if ? [`    only if    : ${a.only_if}`] : []),
        `    then claims: ${a.so}`,
      ].join('\n')).join('\n')}

EVERY ARGUMENT NEEDS BOTH ITS QUESTIONS, AND THE SECOND IS THE ONE THAT GETS FORGOTTEN.

One question that finds the TRIGGER: something dated, so the agent knows the window is open right now. Mark it kind "event".

And one question that establishes the ONLY IF: whether the claim is even true of this company. Mark it kind "state" and set "serves" to that argument's id. This question is not optional and it is not a nice-to-have. The claim in "then claims" is a statement about the prospect's own business, and it is false at plenty of prospects. Without a question establishing it, the agent writes to everyone whose trigger fired and tells most of them something about themselves that nobody checked. Measured on a real book: the trigger fired on 90 accounts, the condition was established on 27, so 63 messages would have asserted it blind.

An argument whose trigger no question can find never fires at all. An argument whose condition no question can establish fires on everyone, which is worse.`);
  }
  if (ctx.about) parts.push(`THE SELLER (who they are, what they sell, who they sell to):\n${ctx.about.slice(0, 2000)}`);
  if (ctx.icp && ctx.icp !== '{}') parts.push(`WHO THEY TARGET (structured):\n${ctx.icp}`);
  if (ctx.value_props.length) parts.push(`WHAT THEIR PRODUCT DOES:\n- ${ctx.value_props.slice(0, 8).join('\n- ')}`);
  if (ctx.pain_points.length) parts.push(`PROBLEMS THEY SOLVE FOR CUSTOMERS:\n- ${ctx.pain_points.slice(0, 8).join('\n- ')}`);
  if (ctx.guidance) parts.push(`OPERATOR GUIDANCE (what they told the agent to dig up):\n${ctx.guidance.slice(0, 1500)}`);
  if (ctx.always_include.length) parts.push(`MUST-COVER topics (each needs >=1 question):\n- ${ctx.always_include.join('\n- ')}`);
  return parts.join('\n\n') || '(nothing provided — produce a neutral, universal brief)';
}

/**
 * Plan a brief from an already-built context. No write.
 *
 * Takes the workspace for the same reason planResearchAngles does: the call runs
 * through chatCompleteForWorkspace so the model is settable per workspace and
 * the customer's own DeepSeek key is the one that pays for it.
 */
export async function planResearchBrief(
  supabase: SupabaseClient,
  workspace_id: string,
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
    return r ? recordReading(r) : '';
  };
  // Every id kept is a slot of already-extracted facts that stays readable.
  const continuityBlock = previous.length
    ? `\n\nTHERE IS ALREADY A BRIEF IN PLACE, AND A RECORD OF WHAT EACH QUESTION HAS EARNED.

Keep the id EXACTLY as written for any question you keep, even if you reword the question itself — a question's track record is filed under its id, and a renamed id starts that record from zero. Invent a new id only for a genuinely new question.

Read the record before you change anything. A question that has found little is USUALLY a badly worded search, not a bad question, and rewriting the question throws away the one thing that was working. Drop a question only when it has had a fair trial AND produces facts no message ever uses.

${previous.map((q) => `  ${q.id} — ${q.question}\n${recordLine(q)}`).join('\n')}`
    : '';
  try {
    const llm = await chatCompleteForWorkspace(supabase, workspace_id, {
      behavior: 'research_brief',
      model: opts?.model ?? BRIEF_MODEL,
      max_tokens: 1600,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: sysPrompt(ctx.max_age_days) },
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
    arguments: (policy.drafter?.arguments ?? []).filter((a) => a?.id && a.enabled !== false),
    guidance: (policy.research?.guidance ?? '').trim(),
    always_include: (policy.research?.always_include ?? []).filter(Boolean),
    max_age_days: policy.research?.max_age_days,
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
  return planResearchBrief(supabase, workspace_id, ctx, { ...opts, previous: policy.research?.brief ?? [] });
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

/** How far back a question's track record is read. */
export const RECORD_WINDOW_DAYS = 30;

/**
 * What each brief question has actually earned, computed from data already
 * stored: run markers, kept pages, the facts read off them, and the drafts that
 * cited those facts. Writes nothing.
 *
 * This is THE definition of those numbers, used by the planner that regenerates
 * the brief, the planner that writes the searches, and
 * `scripts/research_scorecard.ts`. They were computed separately before, and two
 * implementations of the same measure is how you end up reading one number on
 * screen and feeding a different one to the model — the exact confusion that hid
 * a failing search behind a healthy-looking keep count.
 *
 * Both numbers are per QUESTION and neither resets when a search is rewritten,
 * which is what makes a verdict about the question itself possible. `kept` comes
 * off the signals, because a page bought by one angle can be kept as answering a
 * different question.
 */
export interface RunMarker {
  payload: Record<string, Record<string, number> | undefined> | null;
  created_at: string;
}

/**
 * How many pages each question cost, folded out of the research run markers.
 *
 * Pure, and exported for the assertions, because this is where the whole verdict
 * can go wrong quietly. It has to hold two things together:
 *
 * A marker written since the runner started attributing spend to the question
 * says so outright, and that is the only number worth trusting. Reconstructing it
 * from per-angle spend can only credit an angle that STILL serves the question
 * today, and it sweeps in whatever that angle was buying pages for beforehand.
 * Measured live: a question two days old reading 216 pages bought and 1 answer,
 * where the 216 were bought over a month for the question this one replaced. The
 * numerator and the denominator did not start at the same moment, and that is how
 * a perfectly good question gets ruled unanswerable.
 *
 * So a reconstructed marker is counted only from `briefFloor`, when the current
 * question ids came into existence — nothing can have answered a question before
 * it was written. Deliberately NOT applied to `kept`: a regeneration usually
 * preserves an id, and answers stamped under it earlier are genuinely that
 * question's, so clamping them would shrink the numerator instead and condemn a
 * question that was working. Both halves of the asymmetry err the same way,
 * toward leaving a question searchable.
 */
export function foldFetchedByQuestion(
  markers: RunMarker[],
  angles: Array<{ id: string; answers?: string }>,
  briefFloor: number,
): Record<string, number> {
  const byQuestion: Record<string, number> = {};
  const byAngle: Record<string, number> = {};
  for (const e of markers) {
    const perQuestion = e.payload?.per_question_fetched;
    if (perQuestion) {
      for (const [k, v] of Object.entries(perQuestion)) byQuestion[k] = (byQuestion[k] ?? 0) + (Number(v) || 0);
      continue;
    }
    if (Date.parse(e.created_at) < briefFloor) continue;
    for (const [k, v] of Object.entries(e.payload?.per_angle_fetched ?? {})) {
      byAngle[k] = (byAngle[k] ?? 0) + (Number(v) || 0);
    }
  }
  for (const a of angles) {
    if (a.answers && byAngle[a.id]) byQuestion[a.answers] = (byQuestion[a.answers] ?? 0) + byAngle[a.id]!;
  }
  return byQuestion;
}

async function scanQuestionSearch(
  supabase: SupabaseClient,
  workspace_id: string,
  since: string,
  policy: WorkspacePolicy,
): Promise<{ records: QuestionSearchRecord[]; sigQ: Map<string, string> }> {
  const angles = (policy.research?.strategy ?? []).filter((a) => a.enabled !== false);

  // .limit(5000) did not do what it reads as: PostgREST caps a response at 1000
  // rows whatever the limit says. Sudden ran 1,125 researches in the 30 days to
  // 2026-08-14, so 125 were already invisible here, and with no ORDER BY there
  // is no saying which 125, because the planner asked for "the window" and got an
  // arbitrary slice of it.
  //
  // Measured on the day it was found, the numbers this produces did not move:
  // only 248 of those runs carry per-search fetch counts at all, and the slice
  // happened to include every one of them. That is luck, not a guarantee. The
  // number this feeds is the pages a question cost, divided by the answers it
  // kept, and the day the slice starts cutting into runs that do carry counts,
  // a question that earns nothing starts reading as though it pays its way.
  const ev = await fetchAll<{ payload: Record<string, unknown> | null; created_at: string }>((from, to) =>
    supabase.from('events').select('payload, created_at')
      .eq('workspace_id', workspace_id).eq('action', 'research_completed')
      .gte('created_at', since).order('created_at').order('id').range(from, to));
  const fetchedByQuestion = foldFetchedByQuestion(
    ev as RunMarker[],
    angles,
    Date.parse(policy.research?.brief_generated_at ?? '') || 0,
  );

  // fetchAll, because the hand-rolled page loop this replaces threw away the
  // error and then read the empty result as the end of the table. Both failures
  // it hid land on the same number: a read that fails on page one counts zero
  // answers for every question, and a window over 1000 signals paged without a
  // stable order can skip rows outright. Zero answers against real pages spent
  // is what rules a question unsearchable, so a blip could retire a question
  // that is working. Throwing instead reaches a caller that already treats the
  // failure as no verdict rather than a bad one.
  //
  // Ordered by observed_at then id: a total order, and one that appends, so a
  // signal written while the scan is running lands after the current page
  // instead of shifting a row across the boundary.
  const sigs = await fetchAll<{ id: string; structured_tags: Record<string, string> | null }>((from, to) =>
    supabase.from('signals').select('id, structured_tags')
      .eq('workspace_id', workspace_id).eq('type', 'research_result')
      .gte('observed_at', since).order('observed_at').order('id').range(from, to));

  const sigQ = new Map<string, string>();
  const keptByQuestion: Record<string, number> = {};
  for (const s of sigs) {
    const q = s.structured_tags?.answers_question;
    if (!q) continue;
    sigQ.set(s.id, q);
    keptByQuestion[q] = (keptByQuestion[q] ?? 0) + 1;
  }

  const ids = new Set([...resolveBrief(policy).map((q) => q.id), ...Object.keys(keptByQuestion), ...Object.keys(fetchedByQuestion)]);
  return {
    sigQ,
    records: [...ids].map((id) => ({ id, fetched: fetchedByQuestion[id] ?? 0, kept: keptByQuestion[id] ?? 0 })),
  };
}

/**
 * What each question has cost in pages and earned in answers — the half of the
 * record that decides whether searching for it works at all.
 *
 * Split out because that is all the strategy planner needs, and the other two
 * numbers (facts, and facts a draft used) cost a chunked read over every fact
 * and every draft in the window. Same scan, same definition, no second
 * implementation.
 */
export async function loadQuestionSearchRecords(
  supabase: SupabaseClient,
  workspace_id: string,
  days = RECORD_WINDOW_DAYS,
): Promise<QuestionSearchRecord[]> {
  const since = new Date(Date.now() - days * 86400 * 1000).toISOString();
  const policy = await getPolicy(supabase, workspace_id);
  return (await scanQuestionSearch(supabase, workspace_id, since, policy)).records;
}

export async function loadQuestionRecords(
  supabase: SupabaseClient,
  workspace_id: string,
  days = RECORD_WINDOW_DAYS,
): Promise<QuestionRecord[]> {
  const since = new Date(Date.now() - days * 86400 * 1000).toISOString();
  const policy = await getPolicy(supabase, workspace_id);
  const { records, sigQ } = await scanQuestionSearch(supabase, workspace_id, since, policy);

  const sigIds = [...sigQ.keys()];
  const factsByQuestion: Record<string, number> = {};
  const datedByQuestion: Record<string, number> = {};
  const factIdQ = new Map<string, string>();
  // Same cap, one chunk at a time: .limit(3000) over 200 signals still stops at
  // 1000 rows. Nothing has crossed it yet on this book, and nothing warns when
  // it does. The count just quietly stops climbing.
  for (let i = 0; i < sigIds.length; i += 200) {
    const rows = await fetchAll<{ id: string; signal_id: string; happened_at: string | null }>((from, to) =>
      supabase.from('facts').select('id, signal_id, happened_at')
        .in('signal_id', sigIds.slice(i, i + 200)).order('id').range(from, to));
    for (const f of rows) {
      const q = sigQ.get(f.signal_id);
      if (!q) continue;
      factsByQuestion[q] = (factsByQuestion[q] ?? 0) + 1;
      // A stored happened_at has already been through resolveHappenedAt, so it
      // is a date somebody could read rather than a crawl timestamp standing in
      // for one. Counting the column directly is counting anchor candidates.
      if (f.happened_at) datedByQuestion[q] = (datedByQuestion[q] ?? 0) + 1;
      factIdQ.set(f.id, q);
    }
  }

  // This workspace has more than 1000 channels, so the cap was live here: the
  // channels past the first 1000 contributed no drafts, and "facts a draft
  // used" read low for every question.
  const chans = await fetchAll<{ id: string }>((from, to) =>
    supabase.from('channels').select('id').eq('workspace_id', workspace_id).order('id').range(from, to));
  const chanIds = chans.map((c) => c.id);
  const cited = new Set<string>();
  for (let i = 0; i < chanIds.length; i += 200) {
    const posts = await fetchAll<{ cites: string[] | null }>((from, to) =>
      supabase.from('channel_posts').select('cites')
        .in('channel_id', chanIds.slice(i, i + 200)).eq('kind', 'touch_draft')
        .gte('created_at', since).order('created_at').order('id').range(from, to));
    for (const p of posts) for (const c of p.cites ?? []) cited.add(c);
  }
  const usedByQuestion: Record<string, number> = {};
  for (const id of cited) {
    const q = factIdQ.get(id);
    if (q) usedByQuestion[q] = (usedByQuestion[q] ?? 0) + 1;
  }

  // The brief is where a question's declared kind lives, so it is read back here
  // rather than stored on the record: a question reworded from an event into a
  // description should be judged as what it is now, not as what it once claimed.
  const kindById = new Map(resolveBrief(policy).map((q) => [q.id, q.kind === 'event' ? 'event' as const : 'state' as const]));
  const precondition = questionsServingAPrecondition(policy);
  return records.map((r) => ({
    ...r,
    facts: factsByQuestion[r.id] ?? 0,
    dated: datedByQuestion[r.id] ?? 0,
    used: usedByQuestion[r.id] ?? 0,
    kind: kindById.get(r.id) ?? 'state',
    serves_precondition: precondition.has(r.id),
  }));
}

/**
 * Carry a human's off switch across a regeneration.
 *
 * The angle planner had this exact hole and it was fixed there; the brief has
 * carried it the whole time. `coerceQuestion` returns `enabled: true` on
 * everything and the persist replaces the array, so a question a customer
 * switched off in settings comes back on at the next regeneration, in every
 * workspace, with nothing in any log to say why. Only `false` is carried — a
 * question nobody touched has no stored intent, and unset already means enabled.
 *
 * Survives a rewording for the same reason it survives a query rewrite on the
 * angle side: switching a question off is a decision about that question, and the
 * planner rephrasing it is not new information about whether the customer wanted
 * it asked.
 */
export function carryQuestionOffSwitch(next: BriefQuestion[], previous: BriefQuestion[]): BriefQuestion[] {
  const off = new Set(previous.filter((q) => q.enabled === false).map((q) => q.id));
  return next.map((q) => (off.has(q.id) ? { ...q, enabled: false } : q));
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
      brief: carryQuestionOffSwitch(questions, policy.research?.brief ?? []),
      brief_generated_at: new Date().toISOString(),
      ...(input_hash ? { brief_input_hash: input_hash } : {}),
    },
  };
  await supabase.from('workspaces').update({ policy: next }).eq('id', workspace_id);
}

/**
 * How long a rewritten brief is left alone before its record can force another.
 *
 * The reason it is needed at all: a rewrite resets a question's `fetched` (spend
 * is charged from brief_generated_at), which puts it back under the fair-trial
 * guard, so the natural cycle is already rewrite -> protected -> re-judged. On a
 * quiet workspace that is days. On one researching hard it could be an hour, and
 * a planner that keeps returning much the same question would then rewrite the
 * brief every hour, at one LLM call each, churning the questions every angle is
 * built from. A day is long enough that a rewrite gets a real trial and short
 * enough that a broken brief is not left running for a week.
 */
export const BRIEF_REWRITE_COOLDOWN_HOURS = 24;

/**
 * Questions whose track record says they are not earning their pages.
 *
 * Split out from the regeneration path so it can be asserted on directly, and so
 * the scorecard and the dispatcher agree about which questions are failing.
 */
export function questionsNotEarningTheirPages(records: QuestionRecord[]): string[] {
  return records.filter((r) => !makesAccountsWritable(r)).map((r) => r.id);
}

/**
 * Brief questions that exist to establish an argument's condition.
 *
 * Matched on the question's own `serves` field, which the brief planner sets
 * when it writes a question for an argument's `only_if`. Deliberately a declared
 * link and not a guess from wording: a rule that inferred it from the text would
 * be a keyword match, and this decides whether a question is protected from
 * retirement, which is not something to get wrong quietly.
 */
export function questionsServingAPrecondition(policy: WorkspacePolicy): Set<string> {
  const argumentIds = new Set((policy.drafter?.arguments ?? [])
    .filter((a) => a?.id && a.only_if?.trim())
    .map((a) => a.id));
  const out = new Set<string>();
  if (!argumentIds.size) return out;
  for (const q of resolveBrief(policy)) {
    const serves = (q as BriefQuestion & { serves?: string }).serves;
    if (serves && argumentIds.has(serves)) out.add(q.id);
  }
  return out;
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
  if (isBriefCurrent(policy, ctx)) {
    // The hash only covers the INPUTS — About, ICP, the age floor. A question
    // that has been buying pages for a month and has never made one account
    // writable changes none of them, so on the hash alone a broken brief is
    // current forever and every guardrail below is unreachable code. This is the
    // second half of the bug in the comment further down: the records were being
    // loaded and handed to the planner, but nothing could ever call the planner
    // on the strength of what they said.
    //
    // Bounded to once a day per workspace, and deliberately gated on the clock
    // BEFORE the read: loadQuestionRecords scans a month of events, signals,
    // facts and posts, which is not something to run on every dispatcher tick.
    const generatedAt = Date.parse(policy.research?.brief_generated_at ?? '');
    const cooled = !Number.isFinite(generatedAt)
      || Date.now() - generatedAt > BRIEF_REWRITE_COOLDOWN_HOURS * 3600_000;
    if (!cooled) return resolveBrief(policy);
    const judged = records ?? await loadQuestionRecords(supabase, workspace_id).catch(() => []);
    const failing = questionsNotEarningTheirPages(judged);
    if (!failing.length) return resolveBrief(policy);
    const rewritten = await planResearchBrief(supabase, workspace_id, ctx, { previous: policy.research?.brief ?? [], records: judged });
    if (rewritten.source === 'baseline') return resolveBrief(policy);   // never trade tuned questions for the generic set
    await persistResearchBrief(supabase, workspace_id, rewritten.questions, briefInputHash(ctx));
    await supabase.from('events').insert({
      workspace_id,
      actor_kind: 'agent',
      actor_id: 'brief_planner',
      action: 'brief_rewritten',
      target_kind: 'workspace',
      target_id: workspace_id,
      payload: {
        reason: 'questions_not_earning_their_pages',
        failing,
        records: judged.filter((r) => failing.includes(r.id))
          .map((r) => ({ id: r.id, fetched: r.fetched, facts: r.facts, dated: r.dated, used: r.used, kind: r.kind })),
      },
    });
    return rewritten.questions;
  }
  // Load the track record here rather than making every caller remember to pass
  // it. `records` was an optional argument and NO caller ever supplied one — not
  // the dispatcher, not the settings route — so every regeneration in production
  // ran blind and the guardrails were never in the path they were written for.
  // Measured the day this was found: a regeneration dropped a question sitting at
  // 25 pages seen, which the fair-trial guard exists to protect.
  const withRecords = records ?? await loadQuestionRecords(supabase, workspace_id).catch(() => []);
  const stored = policy.research?.brief ?? [];
  const { questions, source } = await planResearchBrief(supabase, workspace_id, ctx, { previous: stored, records: withRecords });
  // Same trap as the strategy planner, and worse here. A transient planner error
  // returns BASELINE_BRIEF, and persisting it would replace a workspace's tuned
  // questions with the generic five, orphan every angle pointed at the old ids,
  // and stamp a fresh input hash so nothing would ever try again. Keep what is in
  // place; the inputs have not changed since the last tick, so the regeneration
  // is still owed and will be attempted next time.
  if (source === 'baseline' && stored.length) return resolveBrief(policy);
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
