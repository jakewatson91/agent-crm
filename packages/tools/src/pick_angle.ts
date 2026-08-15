/**
 * pickDraftAngle — decide WHAT the message argues before the drafter ever sees
 * an exemplar.
 *
 * The problem this solves, with the measurement behind it: the LinkedIn
 * templates are indexed by audience, but each exemplar body carries a finished
 * question, so choosing an audience silently chose that question. MBC Group on
 * 2026-08-04, drafted after three separate prose rules told the model not to
 * copy, produced "does your delivery cost per viewer actually come down, or does
 * it track 1:1 with traffic?" against template 2's "does your delivery cost per
 * viewer fall, or does the cost line grow 1:1 with it?". Rewriting the exemplars
 * into an unrelated industry stopped word-for-word copying but not this: the
 * freight exemplar asks the same question about cost per load, and the model
 * transposes it straight back.
 *
 * More prose cannot fix it, because copying is the cheapest path available while
 * the finished question is sitting in the context window. So: pick the account's
 * problem first, ask which exemplars argue that same problem, and withhold their
 * bodies at render time. The anatomy still teaches shape. The argument is not
 * there to lift.
 *
 * One call on the workspace's cheap model per drafted account, or two when the
 * workspace configured out-of-scope conditions. Returns null on anything
 * unexpected, and the caller then renders exactly what it rendered before. A
 * picker that is down must not stop drafts.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { chatCompleteForWorkspace } from './chat_workspace.ts';

export interface AngleTemplate {
  id: string;
  label?: string;
  /** policy.drafter.templates[].angle — what this exemplar's question argues. */
  angle?: string;
  enabled?: boolean;
}

/**
 * Why no angle was picked. A bare null told you nothing: a model that never ran
 * and a model that ran and found no problem in the facts are different failures
 * with different fixes, and they looked identical on the way out.
 */
export type AngleSkipReason =
  | 'menu_too_small'      // fewer than 2 problems configured — nothing to choose between
  | 'no_facts'            // account has nothing to read
  | 'llm_error'           // the call itself failed
  | 'unparseable'         // came back as something other than the JSON asked for
  | 'no_problem_fits'     // ran fine, and said none of the problems reach this account
  | 'no_evidence'         // picked a problem but could not point at a fact showing it
  | 'all_facts_out_of_scope'; // it has facts, and every one is about a part we cannot serve

export interface AngleDecision {
  /** null means no angle; `reason` says which kind of no. */
  choice: AngleChoice | null;
  reason: AngleSkipReason | 'picked';
  /**
   * Ids of the facts this call judged to be about a part of the business the
   * workspace's out_of_scope conditions rule out. Empty when no conditions are
   * configured, when no fact ids were passed, or when nothing matched. The
   * caller drops these from the drafter's recommended shortlist and marks them
   * in the fact list, which is the part that actually changes what gets
   * written: STEP 0 of the drafter prompt has told the model in prose not to
   * anchor on them since 2026-08-13 and three of four drafts did it anyway,
   * because the fact was still sitting in the shortlist labelled as the
   * freshest thing about the account.
   */
  out_of_scope_fact_ids: string[];
}

export interface AngleChoice {
  /** The chosen problem, verbatim from policy.drafter.pain_points. */
  problem: string;
  /** Its 0-based index in the menu, for instrumentation. */
  problem_index: number;
  /** Why the others fit this account less well. Audit only, never rendered. */
  why: string;
  /** Template ids whose exemplar argues the same thing; bodies get withheld. */
  withheld_template_ids: string[];
}

export interface PickDraftAngleArgs {
  /** Same model string the caller would use for a cheap classification call. */
  model: string;
  account_name: string;
  /**
   * Active facts for the account. Truncated internally. Pass `id` to get the
   * out-of-scope fact ids back; without ids the flagging still guards the pick
   * but the caller has nothing to filter its own shortlist by.
   */
  facts: Array<{ id?: string; predicate: string; object_text: string | null }>;
  /** policy.drafter.pain_points — the menu the drafter already renders. */
  pain_points: string[];
  templates: AngleTemplate[];
  /**
   * policy.drafter.out_of_scope, the same conditions the scorer vetoes on and
   * the drafter reads in STEP 0. Here they do a narrower job: an account can be
   * perfectly sellable and still have facts about the part of it we cannot
   * serve, and those facts must not become the message. Empty (the default) and
   * this whole test is skipped.
   */
  out_of_scope?: string[];
}

/** Facts sent to the picker. Enough to tell the problems apart, not the book. */
const MAX_FACTS = 40;
const MAX_FACT_CHARS = 160;

/**
 * The cap is lifted when the workspace configured out-of-scope conditions,
 * because the flagging job below is only worth anything if it covers every fact
 * the drafter will read. It did not, and that was the leak: ViX carried 60
 * active facts, the picker saw the first 40, and the twelve facts about the part
 * of that account we cannot serve were spread across both halves. The drafter
 * anchored on one from the unseen half, correctly as far as it knew, because it had
 * never been told that fact was off limits.
 *
 * Cheap on this book: 2,243 accounts carry facts, median 5, p99 40, and 22
 * accounts sit over 40. The largest is 133 facts, about 5K tokens on the cheap
 * model, and those big accounts are the researched ones that actually get
 * drafted. Truncating what the flag job reads to save that is a false economy.
 *
 * The pick reads the same widened list, minus whatever the flag job ruled out.
 * That is deliberate, not spillover: at 40 the pick was choosing a problem from
 * a different set of facts than the drafter would go on to write from.
 */
const MAX_FACTS_WITH_SCOPE = 400;

const SYSTEM_PROMPT = `You choose the ARGUMENT an outreach message will make. You do not write the message.

You get one account's facts, a numbered list of problems the seller solves, and a numbered list of the arguments that existing example messages already make.

Two jobs:

1. PICK THE PROBLEM. Choose the one problem on the menu that this account's facts reach in a SINGLE step. A growth number, a launch, a hire, a new market or a stated plan reaches a problem in one step: growth in what they serve reaches a problem about what serving it costs. What does not count is a chain — "they did X, so probably Y, which might mean Z" — or an assumption about what a company of this type generally deals with, with no fact behind it. A fact naming the problem outright is the strongest evidence, but it is not the only kind, and most accounts will never state their own costs.

Return problem 0 only when no fact reaches any problem in one step.

PICK THE ONE THIS ACCOUNT SINGLES OUT. Several problems on the menu will be defensible for almost any account, because they are all problems the seller solves for this whole market. That is not a reason to keep choosing the same one. Test your pick: if the reason you gave would be equally true of every other company in this industry, you have not chosen anything — go back and find the problem THIS account's specific facts point at hardest. The order of the menu means nothing; the first entry is not a default.

2. NAME THE COLLISIONS. Say which of the example arguments make substantially the same argument as the problem you picked. Same argument means a reader would hear the same point, not that they share a word. "Cost per unit does not fall as volume grows" and "the bill tracks traffic one for one" are the same argument. "Cost per unit does not fall as volume grows" and "the team cannot see which customers are expensive" are not.

3. POINT AT THE FACT. Give the number of the ONE fact that shows this problem is real for this account. Not a fact that shows they are big, or busy, or growing: a fact that shows THIS problem. If you cannot point at one, you are assuming the problem rather than finding it, and the answer is 0.

Output strictly valid JSON:
{"problem": <number, 0 if none fit>, "evidence": <the FACTS number that shows it, 0 if none>, "why": "<under 20 words, naming the specific fact that singles this problem out for this account>", "same_argument": [<numbers of colliding examples>]}`;

/**
 * Its own call, before the pick, for workspaces that configured conditions.
 *
 * Both jobs in one call was tried first and lost. One model asked to pick a
 * problem AND to rule out the evidence for it is being asked to throw away its
 * own answer, and it did not: ViX was drafted off "added 3 million paid
 * subscribers attributed to World Cup exclusivity" while that very fact sat in
 * the prompt on a line marked as one it could not use. Split, the pick never
 * sees a ruled-out fact at all, so citing one stops being a rule that can be
 * broken and becomes a fact that is not in the room. Measured after the split,
 * both accounts anchored on the servable half.
 *
 * The split is not what steadied the flag list. That was the temperature, and
 * it swung just as hard after the two calls were separated. See the note there.
 *
 * Nothing here names an industry. The conditions are the workspace's own text.
 */
const SCOPE_SYSTEM = `You sort facts about one company into two piles: the ones an outreach message may be built on, and the ones it may not.

You get a numbered list of facts and a numbered list of conditions describing the parts of a business this seller cannot serve. Most companies do several things, and a company can be a good customer for one part of what it does while another part is nothing this seller can help with.

Take the facts one at a time and apply this test: would a message built on this fact have to name a ruled-out part, or does it take its event, its numbers or its timing from one? If yes, it goes in the second pile.

That catches two kinds. The obvious one is a fact plainly about a ruled-out part. The one that gets missed is a fact reporting something the seller DOES serve, measured by a ruled-out event: growth counted during that event, revenue attributed to it, a record set by it, a plan written in response to it. That fact reads as being about growth, so it survives a test of what it is "about", and then every message written from it opens by naming the event, because the event is where the number came from. It belongs in the second pile.

A fact about the servable part that does not lean on a ruled-out one always stays in the first pile, however large the ruled-out side of the company is. If the conditions do not settle it, leave it in the first pile.

You are not deciding whether to sell to this company. You are deciding which facts can carry a message.

QUOTE OR IT STAYS. For every fact you put in the second pile, copy the words from THAT FACT that name the ruled-out part. Word for word, from the fact's own text, not from the condition and not from what you know about the company. If you cannot copy any words out of the fact itself, the fact does not name a ruled-out part and it belongs in the first pile, however strongly the company is associated with one.

The words you copy have to name the ruled-out thing itself: the kind of work, the event, the deal, the product line the condition describes. A company's name is not one of those, and neither is a country, a region, a date or a season. Partners, distributors, owners and the places a service is sold tell you who and where, not what. A fact that says only who or where does not say which part of the business it is about, whatever you happen to know about that partner. If the only words you can copy are a name, a place or a date, it belongs in the first pile.

Do not copy the whole fact. Copy the part that names the ruled-out thing. If that means copying the whole fact, the fact is entirely about the ruled-out part and that is fine, but check that it is true before you do it.

Output strictly valid JSON, and nothing else:
{"out_of_scope_facts": [{"fact": <the FACTS number>, "quote": "<the words copied from that fact>"}]}
An empty list is the right answer when every fact can carry a message.`;

function factLine(f: { predicate: string; object_text: string | null }): string {
  const v = (f.object_text ?? '').trim().replace(/\s+/g, ' ');
  return `${f.predicate}: ${v.length > MAX_FACT_CHARS ? `${v.slice(0, MAX_FACT_CHARS)}…` : v}`;
}

/** Lowercase, one space between words, no punctuation. Both sides, same rule. */
function loose(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Does the quoted phrase actually appear in the fact the model quoted it from?
 *
 * This is the whole point of asking for a quote, and it has to be checked in
 * code or it is decoration. Without the check the sort ruled out facts on
 * nothing but the company's reputation: NHL.TV's "distribution_region: Canada"
 * and its freshest fact, "NHL.TV will be available exclusively on DAZN in nearly
 * 200 countries", both went out as being about live sport, and neither says
 * anything about live sport. ViX lost "Robust ViX revenue in Mexico, offsetting
 * U.S. advertising softness" the same way. Those are messages we can send.
 *
 * Loose on purpose: case, punctuation and spacing vary between the fact and the
 * quote for no interesting reason. What it will not accept is words that are not
 * there.
 */
function quoteIsInFact(quote: string, factText: string): boolean {
  const q = loose(quote);
  // Two characters is not a quote, it is a coincidence waiting to match.
  return q.length >= 3 && loose(factText).includes(q);
}

/**
 * The network calls this makes, as a parameter so the assertions can count and
 * answer them. `job` says which one is asking: 'scope' sorts the facts, 'pick'
 * chooses the problem. A workspace with no conditions configured only ever
 * makes the 'pick' call.
 */
export type AngleCall = (text: string, job?: 'scope' | 'pick') => Promise<string>;

export async function pickDraftAngle(
  supabase: SupabaseClient,
  workspace_id: string,
  args: PickDraftAngleArgs,
  call?: AngleCall,
): Promise<AngleDecision> {
  const problems = (args.pain_points ?? []).map((p) => p.trim()).filter((p) => p.length > 0);
  const scope = (args.out_of_scope ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
  // One problem is not a choice, and zero is nothing to render. Either way the
  // old path is already correct, so skip the call rather than spend it.
  if (problems.length < 2) return { choice: null, reason: 'menu_too_small', out_of_scope_fact_ids: [] };

  const withAngle = (args.templates ?? []).filter((t) => t && t.enabled !== false && t.angle?.trim());
  const allFacts = (args.facts ?? []).filter((f) => f?.predicate && (f.object_text ?? '').trim())
    .slice(0, scope.length ? MAX_FACTS_WITH_SCOPE : MAX_FACTS);
  if (!allFacts.length) return { choice: null, reason: 'no_facts', out_of_scope_fact_ids: [] };

  const ask = async (job: 'scope' | 'pick', system: string, user: string, max_tokens: number): Promise<string> => {
    if (call) return call(user, job);
    const llm = await chatCompleteForWorkspace(supabase, workspace_id, {
      model: args.model,
      behavior: 'connector_extract',
      max_tokens,
      // Both jobs answer with numbers, and at the default temperature both
      // answered differently on identical input: NHL.TV's 34 facts sorted to 16
      // ruled out on one run and 7 on the next, and ViX's second run ruled out
      // the concurrency facts its first run had just sold on. A sort that is
      // partly a coin toss makes the draft partly a coin toss, and makes any
      // A/B against it unreadable. Same measurement, same fix as the research
      // relevance gate; see the note at its temperature in research_strategy.
      temperature: 0,
      // Nothing here is written prose, so the thinking is spend with no output.
      thinking: 'disabled',
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    });
    return String(llm.text ?? '');
  };

  // ---- Call 1: which facts can carry a message at all ----
  // A failure here returns no flags rather than no angle. The drafter's own
  // STEP 0 still reads the conditions, so a scope call that is down degrades to
  // the behaviour we had before this existed instead of stopping drafts.
  let out_of_scope_fact_ids: string[] = [];
  const flagged = new Set<number>();
  if (scope.length) {
    const scopeUser = [
      `ACCOUNT: ${args.account_name}`,
      '',
      'FACTS:',
      allFacts.map((f, i) => `${i + 1}. ${factLine(f)}`).join('\n'),
      '',
      `PARTS OF A BUSINESS THIS SELLER CANNOT SERVE:\n${scope.map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
    ].join('\n');
    try {
      // A number and a short quote per ruled-out fact, and the biggest account
      // on this book carries 133 facts. The ceiling is not spend, since it is only
      // reached by an account whose every fact is ruled out, and coming back
      // truncated costs the whole list, because half a JSON array parses as
      // nothing.
      const raw = await ask('scope', SCOPE_SYSTEM, scopeUser, 2000);
      const p = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, '').trim()) as { out_of_scope_facts?: unknown };
      for (const row of (Array.isArray(p.out_of_scope_facts) ? p.out_of_scope_facts : [])) {
        // A bare number is the old answer shape. It carries no quote, so there
        // is nothing to check it against, and unchecked is what put facts that
        // never mention a ruled-out part into this list.
        const n = Number((row as { fact?: unknown })?.fact);
        const quote = String((row as { quote?: unknown })?.quote ?? '');
        if (!Number.isInteger(n) || n < 1 || n > allFacts.length) continue;
        const grounded = quoteIsInFact(quote, factLine(allFacts[n - 1]!));
        // ANGLE_DEBUG=1 prints what each fact was ruled out FOR. The ids alone
        // cannot tell a fact ruled out on the words it contains from one ruled
        // out on the company's reputation, and that is the difference between a
        // sort that works and one that quietly costs you your best anchor.
        if (process.env.ANGLE_DEBUG) console.error(`  [scope] ${grounded ? 'KEEP' : 'DROP'} ${allFacts[n - 1]!.predicate} <- "${quote}"`);
        if (!grounded) continue;
        flagged.add(n);
      }
    } catch { /* no flags; see above */ }
    out_of_scope_fact_ids = [...flagged].map((n) => allFacts[n - 1]!.id).filter((id): id is string => typeof id === 'string');
  }

  // The pick reads only what a message may be built on. Withholding rather than
  // forbidding is the point: the previous version showed the picker every fact
  // and told it not to cite the ruled-out ones, and ViX was drafted off "added
  // 3 million paid subscribers attributed to World Cup exclusivity" while that
  // very fact sat in the prompt marked as one it could not use.
  const facts = flagged.size ? allFacts.filter((_, i) => !flagged.has(i + 1)) : allFacts;
  // An account whose every fact is ruled out is not the same as an account with
  // nothing on it, and only one of the two is worth an operator's time: this one
  // is in the book, researched, and its whole story is the part we cannot serve.
  if (!facts.length) return { choice: null, reason: 'all_facts_out_of_scope', out_of_scope_fact_ids };

  // ---- Call 2: which problem, and what shows it ----
  const userPrompt = [
    `ACCOUNT: ${args.account_name}`,
    '',
    'FACTS:',
    facts.map((f, i) => `${i + 1}. ${factLine(f)}`).join('\n'),
    '',
    'PROBLEMS THE SELLER SOLVES:',
    problems.map((p, i) => `${i + 1}. ${p}`).join('\n'),
    '',
    withAngle.length
      ? `ARGUMENTS THE EXAMPLE MESSAGES ALREADY MAKE:\n${withAngle.map((t, i) => `${i + 1}. ${t.angle!.trim()}`).join('\n')}`
      : 'ARGUMENTS THE EXAMPLE MESSAGES ALREADY MAKE:\n(none recorded — return an empty same_argument list)',
  ].join('\n');

  let text: string;
  try {
    text = await ask('pick', SYSTEM_PROMPT, userPrompt, 200);
  } catch {
    return { choice: null, reason: 'llm_error', out_of_scope_fact_ids };
  }

  let parsed: { problem?: unknown; evidence?: unknown; why?: unknown; same_argument?: unknown };
  try { parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, '').trim()); }
  catch { return { choice: null, reason: 'unparseable', out_of_scope_fact_ids }; }

  const idx = Number(parsed.problem);
  // 0 means the picker found nothing in the facts pointing at any problem. That
  // is a real answer, not a failure: fall back to the model choosing from the
  // full menu, which is what it did before this existed.
  if (!Number.isInteger(idx) || idx < 1 || idx > problems.length) return { choice: null, reason: 'no_problem_fits', out_of_scope_fact_ids };

  // The pick has to point at a fact. Without this the model assigned problems
  // that the account's own facts contradict: a subscription service was handed
  // "ads pay a fixed amount per view", and the drafter, told to build its
  // question from that problem and no other, refused rather than write it. The
  // problem was chosen upstream and everything downstream was correct.
  //
  // We cannot check that the cited fact really shows the problem, but requiring
  // a citation makes the model look for one, which is the same trick cite_quotes
  // plays on the drafter. An out-of-range or missing number means it could not
  // find one, and no angle is better than a wrong angle: the drafter then reads
  // the whole menu itself under STEP 2, which demands evidence and stops when
  // there is none.
  //
  // There is deliberately no check here that the cited fact is one we can sell
  // against. It cannot be: the ruled-out facts were dropped before this prompt
  // was built, so `evidence` counts positions in the surviving list. Comparing
  // it against the flag numbers, which count positions in the full list, was
  // wrong in both directions: it threw away good picks whenever anything
  // earlier had been dropped, and it could never catch a bad one.
  const ev = Number(parsed.evidence);
  if (!Number.isInteger(ev) || ev < 1 || ev > facts.length) return { choice: null, reason: 'no_evidence', out_of_scope_fact_ids };

  const collided = Array.isArray(parsed.same_argument) ? parsed.same_argument : [];
  const withheld = collided
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= withAngle.length)
    .map((n) => withAngle[n - 1]!.id);

  return {
    choice: {
      problem: problems[idx - 1]!,
      problem_index: idx - 1,
      why: String(parsed.why ?? '').slice(0, 200),
      withheld_template_ids: [...new Set(withheld)],
    },
    reason: 'picked',
    out_of_scope_fact_ids,
  };
}
