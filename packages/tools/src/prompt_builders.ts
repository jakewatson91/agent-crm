/**
 * Pure prompt builders. No DB, no LLM calls — just string composition.
 * Lives here (not in @agent-crm/primitives or in inngest) so both the runtime
 * agent and the Settings UI's preview endpoint can call them.
 *
 * Behavior identical to the functions that previously lived inside
 * inngest/functions/agent_logic.ts; moved here in Phase 5 so the customer can
 * see exactly what the LLM will be told before saving Settings.
 */
import type { DrafterArgument } from './policy.ts';

// A handful of keys read better with a human label than raw snake_case. The map
// is structural (it never touches the value); unknown keys fall back to a title-
// cased version of the key, so no vertical assumption is baked in.
const ATTRIBUTE_LABELS: Record<string, string> = {
  domain: 'Website',
};

/**
 * Render an entity's attributes as readable lines for a HUMAN-facing prompt
 * (the drafter). Drops internal/plumbing keys, timestamps (`*_at`), id fields
 * (`*_id`), and nested objects/arrays; relabels the few keys that read awkwardly
 * raw.
 *
 * Plumbing detection is structural, never a list of connector key names: any key
 * starting with `_` is treated as reserved/internal and dropped. Connectors that
 * stash working state or discovery hints on an entity prefix those keys with `_`
 * (e.g. `_discovered_via`, `_search_query`) so they never leak into an email and
 * this renderer stays portable — it knows no connector by name. Object/array
 * values (embeddings, the ATS hint blob) are dropped by the type check below
 * regardless of name.
 *
 * The enricher does NOT use this — it needs the raw keys to know what's already
 * extracted. Drafters get prose so the model stops echoing field names like
 * "domain" or "stack" into the email body.
 */
export function renderAttributesProse(attributes: unknown): string {
  if (!attributes || typeof attributes !== 'object') return '(none)';
  const lines: string[] = [];
  for (const [key, value] of Object.entries(attributes as Record<string, unknown>)) {
    if (key.startsWith('_')) continue; // reserved/internal namespace
    if (key.endsWith('_at') || key.endsWith('_id')) continue;
    if (value == null || value === '') continue;
    if (typeof value === 'object') continue; // nested structures aren't prose-worthy
    const label = ATTRIBUTE_LABELS[key] ?? key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    lines.push(`${label}: ${value}`);
  }
  return lines.length ? lines.join('\n') : '(none)';
}

export interface DrafterDecisionOpts {
  /** Which channel to draft for. Defaults to 'email'. */
  outreach_channel?: 'email' | 'linkedin';
  subject_style?: 'one_word' | 'short_phrase' | 'question';
  paragraph_count?: number;
  pain_points?: string[];
  value_props?: string[];
  /**
   * Which step of the sequence this message is, which is what decides how it
   * ends. Default 'open': with no sequence configured every message is a first
   * touch. See ENDING_BY_PURPOSE for why this stopped being the model's choice.
   */
  purpose?: StepPurpose;
  forbidden_phrases?: string[];
  /**
   * Internal field/column names the message must never echo (e.g. "domain",
   * "tech_stack", "score"). These are THIS workspace's own field names, so they
   * live in config (policy.drafter.forbidden_field_terms), not in shared code —
   * a different vertical has different fields. Default empty = rely on the
   * generic "don't name internal fields" rule in STEP 6 alone.
   */
  forbidden_field_terms?: string[];
  /**
   * Language every message is written in (policy.drafter.outreach_language).
   * This was hardcoded to English inside the shared craft block, which is a
   * workspace assumption rather than craft: a customer selling into Germany
   * wants German even when the prospect's own site is in English. Default
   * 'English' leaves every existing workspace byte-identical.
   */
  outreach_language?: string;
  /**
   * Phase 0 market brief: a small list of current, dated market hooks rendered
   * as background context in the drafter prompt. Off or empty renders nothing.
   * Contents live in config (policy.drafter.market_brief), never in shared code.
   */
  market_brief?: { enabled?: boolean; items?: Array<{ text: string; url?: string; date?: string }> };
  /**
   * Workspace message templates (policy.drafter.templates). When non-empty on
   * the linkedin channel, the DM shape below replaces the generic
   * connection-request shape. Contents are config, never code.
   */
  templates?: Array<{ id: string; label: string; audience: string; body: string; angle?: string; anatomy?: string; enabled?: boolean }>;
  /**
   * The argument this message makes, decided before the prompt is built (see
   * pick_angle.ts). `problem` is one entry from pain_points, hoisted out of the
   * menu so the model writes to it instead of choosing from a list it reads
   * after three finished exemplars. `withheld_template_ids` are the templates
   * whose exemplar argues that same thing: they render audience and anatomy
   * with the body cut, because a finished question in context is copied no
   * matter how many rules say not to.
   * Unset = every exemplar renders in full and the model picks its own problem.
   */
  angle?: { problem: string; withheld_template_ids?: string[]; argument?: DrafterArgument };
  /** Drafting rules rendered verbatim above the templates. */
  message_rules?: string[];
  /** Character target for the DM body. Default 400. */
  char_budget?: number;
  /**
   * Accepted and no longer read. It used to tell the model when an event was too
   * old to use as theme evidence, and there are no themes any more: an anchor is
   * either inside trigger_fresh_days or it is not an anchor. Kept on the type so
   * existing call sites and stored config do not break.
   */
  trigger_max_age_days?: number;
  /**
   * How recent an event must be to be worth writing about, in days. One window
   * now, not two — with happened_at on the fact, "fresh enough to lead with" and
   * "old enough to be dead weight" stopped being different questions. Default 30
   * (DEFAULT_ANCHOR_FRESH_DAYS); per-workspace knob, because how fast news dies
   * is a property of the customer's market.
   */
  trigger_fresh_days?: number;
  /**
   * Conditions that make an account unsellable (policy.drafter.out_of_scope).
   * The scorer vetoes these to icp_total 0 so they never reach a draft, but a
   * standing score computed before a condition was added still clears the bar.
   * Rendering them here is the second line: the drafter refuses at write time,
   * which is the last point before a message reaches a person.
   */
  out_of_scope?: string[];
}

/**
 * How to write a first-touch outreach message. This is craft, not content: it is
 * the same for every workspace, every vertical and every channel, so it lives in
 * code next to the other shared machinery rather than on workspaces.policy. What
 * a given customer is allowed to CLAIM (numbers, sources, pricing) is config and
 * stays in the constitution and message_rules.
 *
 * Sourced from the outreach writers whose results are public and measured:
 * Josh Braun (ditch the pitch / poke the bear; never ask for calendar time),
 * 30 Minutes to President's Club (pitching costs up to 57% of replies, leading
 * with the problem adds 20%, an offer-based CTA adds 28%; personalization has to
 * attach to the problem or it reads robotic; ban "nothing nouns" and filler
 * verbs), Chris Voss (no-oriented asks, where "no" still moves it forward), and
 * Lavender's 231,818-email benchmark (replies peak at a fifth-grade reading
 * level; one "talking at you" informative tone costs 26% of replies).
 *
 * Lands in the cached system prefix, which is stable per workspace, so the
 * length is close to free after the first call of a run.
 *
 * CHANNEL-SPECIFIC PARTS ARE NOT HERE. STEP 7 (what shape the message takes) and
 * STEP 8's length target are passed in by the caller. That is what lets an email,
 * a templated DM and a bare connection request share one copy of steps 1-6 and 9,
 * instead of the earlier arrangement where all nine steps rendered only for a
 * templated DM and the email path — the DEFAULT channel — got an older formula
 * with no mode test, no age rules and no think question.
 *
 * WRITING A RULE HERE: do not quote a banned string that would be a usable
 * output in the slot the rule governs. The model completes the pattern instead
 * of avoiding it — STEP 6 used to read `no trailing fragments like "Shows in
 * your dashboard."` and a draft on 2026-08-04 ended with exactly that sentence.
 * State the rule positively (what every sentence must have), or describe the
 * bad SHAPE without handing over a phrase that can be pasted.
 *
 * Quoting is still right in two places, both kept deliberately: the input
 * formats the user message uses, and the industry-cliché bans whose whole value
 * is naming a phrase the model would otherwise reach for on its own. The test is
 * whether the quoted string could be dropped into this message and read as
 * normal.
 *
 * STEP 5's ranked CTAs used to be the third exception, on the reasoning that a
 * PRESCRIBED phrase is safe to quote where a banned one is not. It is not: it
 * fails the same test, and harder, because the model is being told the sentence
 * is the best available. Measured on the 41 real drafts Sudden produced in the
 * 60 days to 2026-08-14: before the craft rules shipped (2026-07-21), 13 of 14
 * drafts closed on a banned CTA. After, banned CTAs went to zero and 17 of 27
 * closed on one of STEP 5's own two example sentences, word for word. The rules
 * did not stop the copying, they changed what got copied. The four asks are
 * described by what they do now, with no finished sentence to paste, which is
 * the same treatment the templated path already gives exemplars.
 *
 * Nothing vertical goes in this block. It is shared by every workspace, so an
 * example borrowed from whichever book we happen to be running is a bug even
 * when it reads well. Three had got in this way and are gone: a two-year-old
 * case study "naming a particular encoder", a "traffic number" beating a
 * conference appearance, and a think question pointed at "their peak". Every
 * illustration here has to survive being read by a workspace selling houses,
 * staffing shifts or freight. `scripts/check_prompt_portability.ts` fails the
 * build on a list of vertical terms; add to that list rather than trusting a
 * grep by hand.
 */
const outreachCraft = (o: {
  freshDays: number;
  /** Workspace's outreach language. Config, not craft. */
  language: string;
  /** STEP 7 body: the channel's shape, starting with its own title line. */
  shape: string;
  /** STEP 8 title line: the channel's length target. */
  target: string;
  /** STEP 5 body: how this message ends, decided by which step of the sequence it is. */
  ending: string;
}) => `Work these steps in order. Do not skip ahead to writing.

STEP 1 — THE EVENT IS ALREADY CHOSEN. READ IT.
The user message carries a block headed THE EVENT THIS MESSAGE IS ABOUT. That is your anchor. It was picked before you saw anything, from facts carrying a real date, inside the last ${o.freshDays} days, checked against what this workspace is allowed to write about, and checked against what has already been said to this account.
You do not choose it, rank it, or look for a better one. Open on it. Cite it.
The one case for stopping is that the anchor cannot reach any problem you solve in a single step (see STEP 2). Then output request_gate and say so. Do not quietly open on something else: a message whose opening is not the reason we wrote is the failure this whole step exists to prevent.
Everything else in the ACTIVE FACTS list is context. Use it for detail, for the question, for what you know about them. Never as the opening.

STEP 2 — TURN THE ANCHOR INTO THE JOB THEY HATE.
Because of this anchor, what unglamorous job or growing cost lands on this person's desk? Write it the way their own team would say it out loud, not the way a product page would. Name the thing that recurs and what it costs them when it does. A category of cost is not a problem; a category of cost with a trigger attached to it is.
ONE HOP, NOT THREE. The anchor must reach the problem in a single step. If you need "they did X, so probably Y, which might mean Z" to get there, the anchor is too weak — stop and request_gate. An award, badge, certification or partner status is recognition of something they already do well, so it almost never reaches a problem in one hop; a growth number, a launch, a hire or a stated plan usually does.
If you could delete the first sentence and the rest still reads fine, the personalization is decoration and you have not done the work.
READ IT BACK AS THEM. Would they think "yes, that is a real problem I have, and this message is about that"? If the most they would think is "correct, that is a fact about us", you have named a fact and not a problem. Go back and find the cost sitting behind the fact.
READ THE ANCHOR THE HONEST WAY, NOT THE CONVENIENT ONE. Most anchors cut both ways: the same hire, the same investment, the same launch can mean they have this problem or that they have just fixed it themselves. Assume they know their own situation better than you do. If the anchor honestly points at "already handled", that LOWERS fit — drop the angle, or put it as a question rather than a verdict, or stop. Never tell them their own strategy is a mistake, and never assert a problem the facts do not clearly support just to reach what you sell.

STEP 3 — WRITE THE THINK QUESTION. This is the most important line in the message.
It makes them check an assumption about the way they do things now. It is never a question about your product.
It must be answerable from memory in one line. If they would have to open a dashboard to answer it, it is too heavy.
Prefer a fork over an open question: two named options cost less to answer than a blank page. "Is that still the same team, or did it move?" and "Did that come out of the existing budget, or a new one?" are forks. "How do you think about X?" is not.
A QUESTION THEY CANNOT ANSWER IS FINE WHEN NOT KNOWING IS THE POINT. What kills a question is not that it asks about a number they do not have, it is that an honest "I would have to check" leaves them nowhere to go, so they say nothing instead. STEP 4 is about naming a cost they cannot currently see; the sharpest way to do that is to ask about it and let them discover they cannot answer.
So the test is not the first word, it is what happens on "I don't know". Ask whether they can SEE the thing, not what its value is: "does that show up broken out anywhere, or does it just sit inside the total?" is answerable from memory by anyone who works there, and a no is the interesting answer. "What share of the total is it?" assumes they have the figure to hand, and if they do not, the question has quietly told them they should, which is the version that gets no reply.
Those two are SHAPES, not scripts, and neither is yours. Build the fork out of the two outcomes THIS account is actually choosing between.
A fork you have already seen in one of the exemplars is the one to avoid. Reusing it is how ten different companies get sent the same question.
Do not answer it about THEM. A pattern you have seen across the category is allowed to come first and set the question up: "most teams at that size find X" followed by "where does yours sit?" is a real question, and handing them something to disagree with is the point of asking. That is what an expert sounds like. What kills the question is asserting the answer for THIS company, because then there is nothing left for them to tell you.
Do not ask a question whose honest answer is "we're fine" with nowhere to go.
BUILD IT FROM THEIR SITUATION, DO NOT COPY AN EXEMPLAR'S. Yours has to point at the specific thing in STEP 2: the number that moved, the market they just entered, the job that got heavier, the thing that changed. A question that names that specific thing is doing the work; the same question with the specifics filed off is not. Test it before you keep it: if your question could be pasted into a message to a different company in this industry without editing a word, it is too generic — rewrite it.

STEP 4 — CRED AND PITCH ARE TOOLS, NOT A QUOTA.
Cred is a pattern you have seen across the category, or a number with a named source. It is never a promise about their results.
The workspace's approved claims and any exemplar's pitch wording are a menu, not a requirement. Use a claim only when it answers the specific problem in STEP 2. When the message's angle doesn't call for one, write no cred at all. A flagship stat jammed into a message whose angle doesn't need it is what makes ten messages read like one mail merge.
Same for the pitch sentence: of the true things you could say about what you sell, pick the one that answers THIS message's problem. An exemplar's wording is one option, not the mandatory one.
The strongest cred names a cost they cannot currently see, rather than a benefit you would deliver.
With no honest pattern and no sourced number, write no cred at all. A missing cred beats an invented one.

STEP 5 — ${o.ending}
KEEP IT UNDER TEN WORDS. Naming their subject costs two or three words, not a clause. One short question, and stop: everything after the question mark is you talking past the ask.
Write it in your own words, with this account's own subject inside it. An ending that would fit any company in this industry with no edit is the wrong one. It is the line most likely to come out identical across every message you write, because it is the last thing written and the least anchored, so give it the same fresh wording STEP 3 demands of the question.
BANNED with no exceptions: "Open to a quick chat?", "Worth a quick call?", "Worth a look?", "Worth exploring?", "Do you have 15 minutes?", "Can we sync?", any proposed day, time or meeting length, and any calendar link. Offering to send something is good, but name the thing you would send: "a one-pager", "a deck" or "some collateral" describes a category of sales material and tells them nothing about what would arrive.

STEP 6 — WELD IT INTO ONE VOICE, THEN LINE EDIT. The steps above are how you THINK; they are not a list of sentences to emit. Your message has fewer sentences than there are steps, because beats share sentences. Weld them: the trigger and the problem it creates belong in one sentence; the credibility number never stands alone, it rides inside a sentence that says what it costs them; the pitch and the ask carry the close. Now read it back as the recipient, out loud. It should sound like one person talking, not parts with the bullets removed.
- Open on them. The first five words are about their world, never yours. If STEP 7's shape opens with a line that disarms the cold approach, that line still has to name them or something they did — a disarm that would fit any recipient is not an opening.
- THE FIRST SENTENCE NAMES THEM AND SOMETHING THEY DID. It has a subject and a verb. A string of nouns, metrics and product names with no verb is a data row, not an opening: company name, then a number, then another number, is the single most common way this message fails. If you cannot get a verb into the opening clause, you picked the wrong anchor — go back to STEP 1 and take one that describes an action.
- DO NOT ANNOUNCE THE ANCHOR BACK TO THEM. They already know what they did. A sentence whose whole job is to state the fact tells the reader nothing they do not know and reads like a record being read out, which is the fastest way to sound automated even when every word is true. The anchor is the PREMISE of your first sentence, not its content: put it in the opening clause and let the rest of the sentence say the part they have NOT already thought about.
  RECITED (wrong): "<their thing> just became your biggest <thing> this quarter, at <exact figure>."
  USED (right):    "With <their thing> doing those numbers this quarter, <the consequence they have not thought about yet>."
  Both name them and something they did. Only the second is worth reading if you already work there.
  THE TEST: read your first sentence as the recipient. If the honest reaction is "yes, I know, I was there", it is a recitation — rewrite it so the sentence still earns its place for someone who knows the fact better than you do.
- QUOTE THEIR NUMBERS THE WAY A COLLEAGUE WOULD, NOT THE WAY A RECORD DOES. A figure repeated back to the person whose figure it is, to the decimal, is the same recitation problem wearing a statistic. Round it, or refer to it without saying it. An exact figure echoed back is a field being read out; "the numbers it did" is a person talking.
- Use their first name ONLY if a named contact was given to you in the user message. If none was, YOU ARE WRITING TO THE COMPANY, not to a person: write no greeting at all and open on them. Never invent a name, never guess one from the company, never address the founder or the head of anything by title, and never leave a slot for someone to fill in. A message addressed to a person who does not work there, or who does not exist, is the fastest way to be marked as spam. A bare greeting with no name is also worse than no greeting, so drop it entirely rather than writing "Hi there". Writing to the company is a normal case, not a degraded one — the opening names what they did, and that needs no name attached.
- Never tell them what they think, feel, worry about or wonder. Anything that assigns them an emotion, or tells them what a fact makes them wonder, is out. State the fact and ask the question; let them supply the feeling.
- Fifth-grade reading level: common words, plain sentences. Short does not mean chopped. A sentence may carry two welded beats joined by a comma or "and" when that makes it flow.
- Punctuation you would actually type into a message box: commas, full stops, question marks. No dashes of any length standing in for a comma or a colon. Nobody reaches for that key on a phone, everybody notices it, and it is the fastest way to look like something a machine produced. If a dash is holding two halves of a sentence together, use a comma, or make it two sentences.
- EVERY sentence has a subject and a verb, the closing one included. A final line that starts with a bare verb is a fragment: give it a subject, or fold it into the sentence before it.
- Cut every word that survives being cut. Kill "just", "quick", "really", "I hope this finds you well", and every exclamation mark.
- No abstract product nouns ("single source of truth", "all-in-one platform", "seamless integration"). A noun phrase that names a category instead of a behavior is the shape to watch for. No filler verbs (streamline, leverage, optimize, empower, unlock, revolutionize).
- Keep the pitch to one sentence, and never place it before the Think question.
- Write in ${o.language}, always, whatever language their own content is in.
- No links.
- Never invent numbers, customer names, case studies, or results.
- NEVER NAME INTERNAL DATA OR FIELD NAMES. Write as a person who researched this company on the open web, not as software reading a record. Do not name the internal field or column any of this is stored under, and do not use data-source language: "our system shows", "your profile", "according to our data", "we have you down as", "based on the signal". Say the real-world thing instead — their site, their product, the tools they named — not the field that holds it. If you cannot say it the way a human researcher would, leave it out.
- Never remark on anyone's race, ethnicity, nationality, gender or religion, even admiringly and even when the source frames it as an achievement. Where a team is based can be business context: time zone, market, cost. Who they are is never a hook. A fact only about who someone is, rather than what the company builds, sells, ships or needs, is not a valid hook — skip it.

STEP 7 — ${o.shape}

STEP 8 — ${o.target} If you are over, cut in this order until you fit:
  1. The verification detail that trails the ask — the clause telling them where they could see the result for themselves.
  2. Adjectives and any clause that restates something already said.
  3. The credibility sentence. It is the most expendable of the four parts; a message with a sharp trigger and a sharp question still works with no cred at all.
  4. The ask itself, falling back to ending on the question from STEP 3.
Never cut the question to fit. Never cut the trigger to fit. Never cut the plain sentence saying what you do while an ask is still in the message: without it the ask means nothing, so cut the ask first and keep the sentence.

STEP 9 — CHECK BEFORE YOU OUTPUT. Any "no" means rewrite.
- Does the message open on the anchor you were given, rather than on something else you preferred?
- Check every dated fact the message references: does any sentence imply an old event just happened?
- Does the anchor reach the problem in one hop?
- Is there a question they can answer from memory in one line, and is it about THEIR situation rather than one you have seen before?
- Does the message open on them, and does that first sentence have a subject and a verb?
- Read the FIRST sentence as the recipient. Is the honest reaction "yes, I know, I was there"? Then it announces their own news back to them instead of using it, and it has to be rewritten.
- Read the LAST sentence on its own. Does it have a subject? If it starts with a verb, it is a fragment — fix it.
- Is the pitch one sentence or less, and does it come after the question?
- Can I source every number and claim?
- Does any sentence name an internal field, or say where the data came from?
- Am I inside STEP 8's target?
- Does it read as one person talking, or as separate beats jammed together? Any bare stat sentence or subjectless fragment gets welded into its neighbor.
- Would this person feel researched, or processed?`;

/**
 * The lead-fact rule. The shortlist decides what is worth CITING; it never
 * decides what the message opens on. That is the anchor, chosen in code.
 *
 * It used to pick the opening, and it could not: the shortlist ranks facts by
 * similarity between the fact and the workspace's own pitch text, and a company
 * description is the densest possible match to a description of who we sell to.
 * Descriptions outranked launches by construction. That is not a tuning problem,
 * it is what cosine similarity does.
 */
const LEAD_FACT_BLOCK = `SUPPORTING FACTS — the user message may include a RECOMMENDED FACTS block, a deterministic shortlist scored on pitch match, recency, confidence and prior over-use. These are the facts most worth CITING for detail or for the question. They are NOT candidates for the opening: the opening is the anchor, and it is already chosen.`;

/**
 * How the message ends, decided by which step of the sequence it is.
 *
 * The ending was the one line that came out word-for-word identical across
 * different accounts, and the reason is structural: it was the last thing
 * written, the model chose it from a fixed ranked menu, and it was the only part
 * with no account-specific input at all. Measured over 41 real drafts, the craft
 * rules moved banned CTAs to zero and then 17 of 27 drafts closed on one of the
 * menu's own two example sentences instead. The rules did not stop the copying,
 * they changed what got copied.
 *
 * So it stops being a choice. It is not a property of the message anyway, it is
 * a property of where you are in the conversation: on a first touch they have
 * never heard of you, so a reply is the only thing you can ask for, and at 300
 * characters there is no room to both explain yourself and make an offer.
 */
export type StepPurpose = 'open' | 'offer' | 'close';

const ENDING_BY_PURPOSE: Record<StepPurpose, string> = {
  open: `END ON THE QUESTION. NEVER ASK FOR TIME.
This is the first time they have heard from you. An offer means nothing before you have said what you do, and there is no room here to do both, so do neither. The think question from STEP 3 IS the ending. Stop after it.
Do not add an offer, a next step, or a sentence about what you sell. A reply is the win.`,
  offer: `OFFER TO DO THE WORK. NEVER ASK FOR TIME.
They have heard from you once and did not reply, so a sentence about what you do has now been earned. Offer to work something out about THEIR situation and tell them the answer: a number for their case, an estimate for the thing in the anchor, a check of an assumption they are running on.
WHAT YOU OFFER IS AN ANSWER, NEVER A DOCUMENT. The moment the offer becomes a thing you would send rather than something you would find out, it is sales material and it is refused. If the sentence names a format instead of a finding, rewrite it as the finding.
Say what you do in one plain sentence BEFORE the offer. An offer to work something out is meaningless to someone who has not been told what you do.`,
  close: `GIVE THEM THE EASY OUT. NEVER ASK FOR TIME.
This is the last message. Ask whether the problem from STEP 2 is already covered, in a form where "yes, handled" is a one-word reply that costs them nothing. A question they can close with one word gets answered.
Then stop. Nothing follows this message, so do not hint at one.`,
};

/**
 * The out-of-scope refusal. Rendered on every channel: it used to appear only on
 * the templated-DM path, so a workspace on the default email channel had the
 * scorer's veto and no draft-time backstop at all. Conditions are config and
 * start empty, so a workspace that has set none renders nothing.
 */
function scopeStep(out_of_scope?: string[]): string {
  const scope = (out_of_scope ?? []).filter((s) => s.trim().length > 0);
  if (!scope.length) return '';
  // Only the ACCOUNT test is left here. The fact-level version — "this subject is
  // never what a message is about" — used to be a second paragraph under the same
  // heading, doing a different job with the same list. It is now its own setting
  // (cannot_write_about) and, more to the point, its own step in code: a fact
  // matching it is dropped from the anchor candidates before the model is asked
  // anything, which is the only version of this rule that has ever held. The
  // paragraph was in the prompt from 2026-08-13 and three of four drafts anchored
  // on a ruled-out fact anyway.
  return `\nSTEP 0 — CAN WE EVEN SERVE THEM? Do this before reading anything else.
These conditions mean this account is not sellable, whatever their fit score says:
${scope.map((s) => `  - ${s}`).join('\n')}
Check each one against the account's facts. If one clearly applies, stop and output:
{"action":"request_gate","body":"<the condition, and the fact that shows it>","policy":"account_out_of_scope"}
Only stop on evidence in the facts, never on an assumption about what a company like this probably does. If the facts don't settle it, carry on and draft.
`;
}

export function buildDrafterDecision(opts: DrafterDecisionOpts): string {
  const language = opts.outreach_language?.trim() || 'English';
  const freshDays = opts.trigger_fresh_days ?? 14;
  const scopeBlock = scopeStep(opts.out_of_scope);
  // The request_gate lines below say "any step above" rather than listing step
  // numbers. STEP 0 only exists when the workspace configured out-of-scope
  // conditions, and a hardcoded list naming a step that is not in the prompt
  // leaves the model hunting for what it missed.
  const pains = (opts.pain_points ?? []).filter((s) => s.trim().length > 0);
  const values = (opts.value_props ?? []).filter((s) => s.trim().length > 0);
  // Which step of the conversation this is. Explicit setting wins; with none,
  // the LinkedIn branch reads it off the shape below, because a 400-character DM
  // is only ever sent after a connection has been accepted, which makes it a
  // second touch by definition.
  const purpose = opts.purpose;
  const fieldTerms = (opts.forbidden_field_terms ?? []).filter((s) => s.trim().length > 0);
  const fieldTermsLine = fieldTerms.length
    ? `\n- On top of STEP 6's rule, never name these internal fields: ${fieldTerms.map((t) => `"${t}"`).join(', ')}.`
    : '';

  if ((opts.outreach_channel ?? 'email') === 'linkedin') {
    const templates = (opts.templates ?? []).filter((t) => t && t.enabled !== false && t.body?.trim() && t.audience?.trim());
    {
      const rules = (opts.message_rules ?? []).filter((s) => s.trim().length > 0);
      const budget = opts.char_budget ?? 400;
      // The LENGTH decides the shape, not whether example messages exist.
      // LinkedIn hard-cuts a connection request at 300 characters, so a budget
      // at or under that IS one: no room for a sentence saying what you do, so
      // the think question has to carry the whole message.
      //
      // This used to key off the examples instead. With none configured the
      // whole thing fell through to a 250-character connection request, so a
      // workspace that had not written examples got a different and much
      // shorter message rather than the same message without examples. That
      // made examples effectively mandatory, which they were never meant to be.
      const isConnect = budget <= 300;
      // A connection request is the first thing they see, so it ends on the
      // question and offers nothing. A DM has already had one accepted, so a
      // sentence about what you do has been earned and the offer belongs there.
      const ending = ENDING_BY_PURPOSE[purpose ?? (isConnect ? 'open' : 'offer')];
      const rulesBlock = rules.length
        ? rules.map((r) => `- ${r}`).join('\n')
        : `- Aim for under ${budget} characters.`;
      // An exemplar that argues the same point this message will argue gets its
      // body cut, not a rule asking the model to please not copy it. That rule
      // was written three times and lost to the exemplar all three times: with
      // a finished question sitting in context, copying is the cheapest path
      // available. The anatomy stays, so sentence count, beat order and rhythm
      // still transfer — only the argument is gone.
      const withheld = new Set((opts.angle?.withheld_template_ids ?? []).filter((id) => typeof id === 'string' && id.trim()));
      // Cutting the body is not enough on its own. An anatomy is written to
      // explain the exemplar, so it tends to quote its sharpest lines back, and
      // a quoted sentence in the anatomy is the same paste-ready sentence the
      // withholding exists to remove. Sudden's anatomies quote the closing ask
      // word for word, and that ask came back in 17 of 27 live drafts. Quoted
      // spans go only on the withheld ones: on a template the model is allowed
      // to read in full, the anatomy quoting it changes nothing.
      const stripQuoted = (s: string) => s.replace(/["“][^"”]{4,}["”]/g, '[wording withheld]');
      const templatesBlock = templates
        .map((t, i) => {
          const head = `[${i + 1}] ${t.label}\n    AUDIENCE: ${t.audience}`;
          if (withheld.has(t.id)) {
            const anatomy = t.anatomy ? `\n    ANATOMY: ${stripQuoted(t.anatomy)}` : '';
            return `${head}\n    EXEMPLAR: WITHHELD — this one argues the same point you are writing to, so its wording is not available to you. Its shape is still yours to use: build it from the anatomy.${anatomy}`;
          }
          return `${head}\n    EXEMPLAR: "${t.body}"${t.anatomy ? `\n    ANATOMY: ${t.anatomy}` : ''}`;
        })
        .join('\n\n');
      // Only rendered when the workspace wrote examples. With none, the beat
      // order comes from the shape below, which says the same thing in prose.
      const templatesSection = templates.length
        ? `\nTEMPLATES — these set the SHAPE and the audience. The content comes from the account and from the menu below, never from the exemplar.
An exemplar may deliberately be written about a different industry from the one you are selling into. That is not a mistake and it is not a hint to change subject: it is there so you take the rhythm, the sentence count and the order of beats, and nothing else. If a phrase from an exemplar would fit in your message unchanged, you are copying rather than writing.

${templatesBlock}
`
        : '';
      // The menu STEP 4 refers to. Both are derived from the workspace's own
      // ABOUT at setup and were being computed, stored, passed in here, and then
      // dropped — this branch used to return without ever rendering them, so the
      // exemplars were the only content the model had and every draft converged
      // on the one argument they carry. Neither list is a credibility claim: the
      // constitution still governs what may be asserted.
      //
      // When the angle was picked upstream, the menu collapses to the one
      // problem. Leaving all of them in front of the model reopens the door
      // this was built to close: it would read the list after three exemplars
      // and pick whichever one the exemplars had already argued.
      const chosenProblem = opts.angle?.problem?.trim();
      const arg = opts.angle?.argument;
      // A written-down argument is not a richer problem statement, it is a
      // different instruction. With a bare problem the model still has to work
      // out what the anchor has to do with it and what to ask for, and that
      // derivation is where 26 drafts went wrong at once: from an About text
      // about simultaneous audiences, "so let us carry your premiere" is the
      // most probable conclusion any reader would reach, and it is the opposite
      // of what the seller sells. Here the reasoning is already done and the
      // model's job is to say it well about this specific company.
      const painsBlock = arg
        ? `THE ARGUMENT YOU ARE MAKING — not a menu, and not yours to re-derive. It was matched to this account's facts before you saw any exemplar, and its condition was checked against them.
  BECAUSE THIS HAPPENED: ${arg.when.trim()}
  WHAT IT COSTS THEM:    ${arg.so.trim()}
  WHAT YOU ARE ASKING:   ${arg.ask.trim()}
Write THIS argument about THIS company. Do not reach a different conclusion from the anchor, however reasonable the other one seems — a conclusion that sounds obvious from what the product does is exactly the one that has been wrong before.
The ask is scoped as written. Asking for more than it says, or for the thing it excludes, is the failure this block exists to stop.
Build your Think question from what it costs them. If nothing in the facts actually shows that, do not substitute a different argument — stop and request_gate, as STEP 2 says.\n`
        : chosenProblem
        ? `THE PROBLEM YOU ARE WRITING TO — chosen for this account by reading its facts, before you saw any exemplar:\n  ${chosenProblem}\nBuild your Think question from this one and no other. If nothing in the facts actually shows this problem, do not substitute a different one — stop and request_gate, as STEP 2 says.\n`
        : pains.length
          ? `PROBLEMS WE SOLVE — pick the ONE this account's anchor actually points at, and build your Think question from it. Never default to the first, and never list more than one in a message.\n${pains.map((p) => `  - ${p}`).join('\n')}\n`
          : '';
      const menuBlock = (painsBlock || values.length)
        ? `\n${painsBlock}${values.length ? `\nWHAT IT ACTUALLY DOES — true behaviors you may state. Pick the one that answers the problem you chose; the exemplar's wording is one option, not the required one.\n${values.map((v) => `  - ${v}`).join('\n')}\n` : ''}`
        : '';

      // The beats, in order, at DM length. This is what the examples used to be
      // the only source of: with none configured, nothing told the model what a
      // message was made of. Beat 4 is the one Jake's rule turns on, and it is
      // stated as a requirement rather than a preference because the drafts that
      // ended on "already got that handled?" with no sentence in front of it
      // were asking the reader to guess what "that" was.
      const dmShape = `FILL THE MESSAGE SHAPE. These beats in this order, welded per STEP 6, so the message has fewer sentences than it has beats.
1. The anchor from STEP 1 opens it, naming them and something they did.
2. The problem from STEP 2. It usually rides inside the same sentence as the anchor rather than getting one of its own.
3. The think question from STEP 3. It comes before anything about what you sell.
4. ONE plain sentence saying what the thing you sell actually does, taken from the menu below.
5. The ask from STEP 5, under ten words.
Beat 4 is not optional whenever beat 5 is there. An offer to do something, or a question asking whether they have this handled, means nothing to someone who has not been told what the thing is.`;

      const connectShape = `FILL THE CONNECTION-REQUEST SHAPE.
- Maximum ${budget} characters total. Count carefully — LinkedIn hard-cuts at 300.
- No greeting and no sign-off. LinkedIn prepends the sender's name automatically.
- The anchor from STEP 1 opens it. The problem from STEP 2 is implied by the question rather than spelled out; there is no room to state both.
- At this length the think question IS the ask, which is ending 4 in STEP 5. There is no room for a sentence saying what you do, and without one an offer is meaningless, so write neither.
- No subject line — set "subject" to null in your output.`;

      const templateGuidance = templates.length
        ? `\n\nPICK ONE TEMPLATE AND MATCH ITS SHAPE.
Pick the exemplar whose AUDIENCE is closest to who you are writing to, and if none of them is close, take the one whose shape suits the message and carry on. A mismatch is not a reason to stop: it used to be, and that rule alone refused roughly 40 of 56 drafts on this workspace for the sole reason that nobody had attached a job title to the account.
What MUST be built fresh for this account: the anchor, the problem in STEP 2, and the think question. Never take those from the exemplar.
What MAY repeat across accounts: approved claim wording and the sentence describing what you do. What never varies is honesty and shape discipline.
GET THIS ASYMMETRY THE RIGHT WAY ROUND. The approved wording is the part that SHOULD stay word for word: it is approved because someone checked it. The anchor and the question are the parts that MUST change. Rewriting an approved term into a loose synonym while keeping the exemplar's question is backwards on both counts — it makes the claim vaguer and the message identical. If you find yourself reaching for a different word for something the workspace already names, stop: use their word, and spend the originality on the question instead.
Two tests, both must pass. CONTENT: the anchor, the problem and the think question are built from THIS account and read nothing like the exemplar's. SHAPE: your sentence count, your order, and where you fuse beats are your own, not a trace of the exemplar's outline. A draft with a fresh anchor is still a clone if it walks the exemplar's shape sentence for sentence. If either fails, go back to STEP 3.`
        : '';

      const shape = `${isConnect ? connectShape : dmShape}${templateGuidance}`;

      return `A new high-fit signal matched your saved filter rule. Write the ${isConnect ? 'LinkedIn connection request' : 'LinkedIn DM'} for this account${templates.length ? ', following the workspace templates below' : ''}.
${scopeBlock}

${outreachCraft({ freshDays, language, shape, ending, target: `COUNT THE CHARACTERS. The body comes in under ${budget}.` })}

THIS WORKSPACE'S RULES — these override anything above if they conflict:
${rulesBlock}
- No greeting-and-sign-off padding. LinkedIn shows the sender's name.
- No subject line — set "subject" to null in your output.${fieldTermsLine}
${templatesSection}${menuBlock}
${LEAD_FACT_BLOCK}

REQUEST_GATE — when any step above tells you to stop, output exactly:
{"action":"request_gate","body":"<one sentence: the fact you would need>","policy":"facts_insufficient_for_draft"}
The body names a MISSING FACT, one that would let you write the message if you had it. It is not a reason you thought of. Refusing because they are large, because they might build it themselves, because they may not buy from an outside supplier, or because you cannot see how a deal would work are all guesses about how they behave, not facts about them, and none of them is a reason to stop: those are objections to handle in a conversation you have not had yet. ${scopeBlock ? 'The ONLY grounds for stopping are one of the conditions listed at the very top, or a fact' : 'The only grounds for stopping are a fact'} you need and do not have. If you cannot name the missing fact in one sentence, you do not have a reason to stop, so write the message.

REASONING — include a "reasoning" field: ${templates.length ? 'name the template you chose, ' : ''}the anchor you opened on and its date, the problem you took it to, and why that reaches this recipient. Shown in the audit channel, never sent to the recipient.
${chosenProblem
  ? 'Also quote the one fact that shows the problem above is real for this account. If you cannot point at a fact, you are assuming it, and an assumed problem is a gate, not a draft.'
  : 'Also name which problem from the menu you built the question on, and say in a few words why the OTHER problems fit this account less well. If you cannot give a reason the others lose, you did not choose — you took the first one. Go back and read the account\'s facts against all of them before writing.'}

CITE_QUOTES — for each id in "cites", also add an entry to "cite_quotes" giving the exact phrase copied verbatim from your "body" that reflects that fact (a few words, not the whole sentence). This is what lets the UI underline the claim in place — the phrase must appear in "body" character-for-character.

Output strictly valid JSON:
{"action":"post_touch_draft","subject":null,"body":"<${isConnect ? `linkedin connection request, max ${budget} chars` : `linkedin DM, aim under ${budget} chars`}>","cites":["<fact_id_uuid>",...],"cite_quotes":[{"fact_id":"<fact_id_uuid>","quote":"<exact phrase from body>"},...],"reasoning":"<${templates.length ? 'template chosen + ' : ''}trigger + why this recipient>","to_email":null}`;
    }
  }

  // ---- email, the default channel ----
  const ending = ENDING_BY_PURPOSE[purpose ?? 'open'];
  const style = opts.subject_style ?? 'one_word';
  const paraCount = opts.paragraph_count ?? 4;
  // Default is empty on purpose. It used to be ['Worth exploring?', 'Open to a
  // quick chat?'], and the second of those is on STEP 5's no-exceptions ban
  // list — the shared craft banned a phrase the shared default handed over.
  // Empty falls through to STEP 5's ranked list, which is the better ask anyway.
  const forbidden = (opts.forbidden_phrases ?? []).filter((s) => s.trim().length > 0);
  // Market brief: background context only. Off or empty contributes nothing, so
  // the prompt stays byte-identical (and cache-identical) for workspaces that
  // haven't opted in. Capped at 5 so it can't balloon the cached system prefix.
  const briefItems = (opts.market_brief?.enabled ? (opts.market_brief.items ?? []) : [])
    .filter((i) => i && typeof i.text === 'string' && i.text.trim().length > 0)
    .slice(0, 5);
  const marketBriefBlock = briefItems.length
    ? `\n\nMARKET BRIEF (current background context, NOT facts about this account):\n${briefItems
        .map((i) => {
          const date = i.date ? ` (${i.date})` : '';
          const src = i.url ? ` [${i.url}]` : '';
          return `   - ${i.text.trim()}${date}${src}`;
        })
        .join('\n')}\nUSE: on a follow-up or a re-engagement after a long gap, where the strongest account facts were already spent on an earlier email, you MAY open with ONE of these market shifts as a genuine reason to write again, then connect it to them. At most one item, framed as something you have noticed in the market, never a stat dump.
STEP 1 STILL GOVERNS THE FIRST TOUCH. A market shift is not an anchor: it is not a fact about THEM. On a first touch with no honest anchor, request_gate — do not open on the brief.`
    : '';

  const subjectInstruction = style === 'one_word'
    ? 'SUBJECT — exactly ONE word. A concrete noun, ideally tied to the specific signal that triggered this. Never vague words like "Hello", "Question", "Quick", "Connect".'
    : style === 'question'
    ? 'SUBJECT — phrase as a short, specific question (under 60 chars). Avoid generic openers.'
    : 'SUBJECT — short phrase, 2-5 words. Concrete and signal-specific. Avoid vague openers like "Quick question" or "Following up".';

  // The argument, when one was matched, replaces the problem menu here exactly
  // as it does on the LinkedIn branch above. Same order of preference: the
  // argument, then the single problem the picker chose, then the menu.
  //
  // Without this the email channel accepted an argument and rendered none of
  // it, and email is the default channel, so every workspace the setup wizard
  // creates was storing an argument that never reached a message.
  const arg = opts.angle?.argument;
  const chosenProblem = opts.angle?.problem?.trim();
  const painBlock = arg
    ? `THE ARGUMENT YOU ARE MAKING — 1-2 sentences. Not a menu, and not yours to re-derive: it was matched to this account's facts before you saw this prompt, and its condition was checked against them.
   BECAUSE THIS HAPPENED: ${arg.when.trim()}
   WHAT IT COSTS THEM:    ${arg.so.trim()}
   WHAT YOU ARE ASKING:   ${arg.ask.trim()}
   State what it costs them, in the language a prospect EXACTLY LIKE THIS ACCOUNT would use, tied to a specific fact about THIS account. Do not reach a different conclusion from the anchor, however reasonable the other one seems — a conclusion that sounds obvious from what the product does is exactly the one that has been wrong before. If nothing in the facts actually shows what it costs them, do not substitute a different argument — stop and request_gate, as STEP 2 says.`
    : chosenProblem
    ? `PROBLEM STATEMENT — 1-2 sentences naming this problem, chosen for this account by reading its facts before you saw this prompt:\n   ${chosenProblem}\n   Say it in the language a prospect EXACTLY LIKE THIS ACCOUNT would use, and tie it to a specific fact about THIS account. If nothing in the facts actually shows this problem, do not substitute a different one — stop and request_gate, as STEP 2 says.`
    : pains.length
    ? `PROBLEM STATEMENT — 1-2 sentences naming the problem you found in STEP 2, in the language a prospect EXACTLY LIKE THIS ACCOUNT would use. The pains this product speaks to (pick the one that fits, never list them all):\n${pains.map((p) => `   - ${p}`).join('\n')}\n   Tie it to a specific fact about THIS account.`
    : `PROBLEM STATEMENT — 1-2 sentences naming the problem you found in STEP 2, anchored in one of the entity's active facts. Don't generalize.`;

  const valueBlock = values.length
    ? `ONE-LINER — 1 sentence stating a CONCRETE behavior of the product. Pick the one that answers the problem above:\n${values.map((v) => `   - ${v}`).join('\n')}`
    : `ONE-LINER — 1 sentence stating a CONCRETE behavior or number about the product. Avoid generic phrases.`;

  // Heading only when the workspace actually put something under it.
  const wsRules = fieldTermsLine
    ? `THIS WORKSPACE'S RULES — these override anything above if they conflict:${fieldTermsLine}\n`
    : '';

  // With an argument matched, the ask is already decided and scoped. Leaving
  // this on STEP 5's generic ending would let the email close on something
  // wider than the argument asks for, which is the one failure the ask being
  // written down at all is meant to prevent.
  const askBlock = arg
    ? `ASK — one short sentence, in your own words, asking for exactly this and nothing wider: ${arg.ask.trim()}\n   Asking for more than it says, or for the thing it excludes, is the failure this line exists to stop.`
    : 'ASK — the ending STEP 5 gives you, in one short sentence.';

  const forbiddenBlock = forbidden.length
    ? `\nFORBIDDEN PHRASES (do NOT use any variant): ${forbidden.map((p) => `"${p}"`).join(', ')}. These are filler. Use a concrete behavior or a number instead.`
    : '';

  const shape = `FILL THE EMAIL SHAPE. These parts in this order, welded per STEP 6 into roughly ${paraCount} short paragraphs separated by blank lines. There are more parts than paragraphs on purpose — parts share sentences.
1. ${subjectInstruction}
2. ACCUSATION AUDIT — one short sentence that admits this is a cold email and takes the pressure off. Write it fresh in your own words, tied to why you are writing to THIS company. Per STEP 6 it has to name them or something they did; a stock disarm that would fit any recipient is not an opening. Don't apologize twice. Don't qualify it.
3. ${painBlock}
4. THINK QUESTION — the line you wrote in STEP 3. It goes before anything about the product.
5. ${valueBlock}
6. ${askBlock}${forbiddenBlock}`;

  return `A new high-fit signal matched your saved filter rule. Draft an outbound email to the account in the user message.
${scopeBlock}

${outreachCraft({ freshDays, language, shape, ending, target: `COUNT THE PARAGRAPHS. The body is roughly ${paraCount} short paragraphs separated by blank lines.` })}

${wsRules}${marketBriefBlock}

${LEAD_FACT_BLOCK}

RECIPIENT — if CONTACTS are present in the user message, pick the best fit for the angle. Echo the chosen email in the output's "to_email" field. If no CONTACTS, set "to_email" to null.

Voice and hard rules come from the workspace constitution above. The constitution wins over everything here on tone — if it bans a punctuation mark or a word, follow it strictly even where an example above uses one.

The decision to draft has already been made upstream — a deterministic action selector ran the scores against thresholds before invoking you. You are here because the entity cleared all the bars. Your job is to WRITE the email, not to second-guess.

REQUEST_GATE — when any step above tells you to stop, output exactly:
{"action":"request_gate","body":"<one sentence: what specific fact you'd need>","policy":"facts_insufficient_for_draft"}
It is a real escape hatch, not the default path.

REASONING — every post_touch_draft output MUST include a "reasoning" field: the anchor you opened on and its date, plus the 2-3 facts you cited, in 1-2 sentences. This becomes a separate "decision" post in the channel so the human auditor can see why each draft happened.

CITE_QUOTES — for each id in "cites", also add an entry to "cite_quotes" giving the exact phrase copied verbatim from your "body" that reflects that fact (a few words, not the whole sentence). This is what lets the UI underline the claim in place — the phrase must appear in "body" character-for-character.

Output strictly valid JSON, no preamble:
{"action":"post_touch_draft","subject":"<see subject rule>","body":"<email body, ~${paraCount} short paragraphs separated by blank lines>","cites":["<fact_id_uuid>",...],"cite_quotes":[{"fact_id":"<fact_id_uuid>","quote":"<exact phrase from body>"},...],"reasoning":"<mode + which facts you anchored to>","to_email":"<picked contact email or null>"}`;
}
