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
 * One call on the workspace's cheap model per drafted account. Returns null on
 * anything unexpected, and the caller renders exactly what it rendered before —
 * a picker that is down must not stop drafts.
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
  | 'no_problem_fits';    // ran fine, and said none of the problems reach this account

export interface AngleDecision {
  /** null means no angle; `reason` says which kind of no. */
  choice: AngleChoice | null;
  reason: AngleSkipReason | 'picked';
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
  /** Active facts for the account. Truncated internally. */
  facts: Array<{ predicate: string; object_text: string | null }>;
  /** policy.drafter.pain_points — the menu the drafter already renders. */
  pain_points: string[];
  templates: AngleTemplate[];
}

/** Facts sent to the picker. Enough to tell the problems apart, not the book. */
const MAX_FACTS = 40;
const MAX_FACT_CHARS = 160;

const SYSTEM_PROMPT = `You choose the ARGUMENT an outreach message will make. You do not write the message.

You get one account's facts, a numbered list of problems the seller solves, and a numbered list of the arguments that existing example messages already make.

Two jobs:

1. PICK THE PROBLEM. Choose the one problem on the menu that this account's facts reach in a SINGLE step. A growth number, a launch, a hire, a new market or a stated plan reaches a problem in one step: growth in what they serve reaches a problem about what serving it costs. What does not count is a chain — "they did X, so probably Y, which might mean Z" — or an assumption about what a company of this type generally deals with, with no fact behind it. A fact naming the problem outright is the strongest evidence, but it is not the only kind, and most accounts will never state their own costs.

Return problem 0 only when no fact reaches any problem in one step.

PICK THE ONE THIS ACCOUNT SINGLES OUT. Several problems on the menu will be defensible for almost any account, because they are all problems the seller solves for this whole market. That is not a reason to keep choosing the same one. Test your pick: if the reason you gave would be equally true of every other company in this industry, you have not chosen anything — go back and find the problem THIS account's specific facts point at hardest. The order of the menu means nothing; the first entry is not a default.

2. NAME THE COLLISIONS. Say which of the example arguments make substantially the same argument as the problem you picked. Same argument means a reader would hear the same point, not that they share a word. "Cost per unit does not fall as volume grows" and "the bill tracks traffic one for one" are the same argument. "Cost per unit does not fall as volume grows" and "the team cannot see which customers are expensive" are not.

Output strictly valid JSON:
{"problem": <number, 0 if none fit>, "why": "<under 20 words, naming the specific fact that singles this problem out for this account>", "same_argument": [<numbers of colliding examples>]}`;

function factLine(f: { predicate: string; object_text: string | null }): string {
  const v = (f.object_text ?? '').trim().replace(/\s+/g, ' ');
  return `${f.predicate}: ${v.length > MAX_FACT_CHARS ? `${v.slice(0, MAX_FACT_CHARS)}…` : v}`;
}

export async function pickDraftAngle(
  supabase: SupabaseClient,
  workspace_id: string,
  args: PickDraftAngleArgs,
): Promise<AngleDecision> {
  const problems = (args.pain_points ?? []).map((p) => p.trim()).filter((p) => p.length > 0);
  // One problem is not a choice, and zero is nothing to render. Either way the
  // old path is already correct, so skip the call rather than spend it.
  if (problems.length < 2) return { choice: null, reason: 'menu_too_small' };

  const withAngle = (args.templates ?? []).filter((t) => t && t.enabled !== false && t.angle?.trim());
  const facts = (args.facts ?? []).filter((f) => f?.predicate && (f.object_text ?? '').trim()).slice(0, MAX_FACTS);
  if (!facts.length) return { choice: null, reason: 'no_facts' };

  const userPrompt = [
    `ACCOUNT: ${args.account_name}`,
    '',
    'FACTS:',
    facts.map((f) => `- ${factLine(f)}`).join('\n'),
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
    const llm = await chatCompleteForWorkspace(supabase, workspace_id, {
      model: args.model,
      behavior: 'connector_extract',
      max_tokens: 200,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    });
    text = String(llm.text ?? '');
  } catch {
    return { choice: null, reason: 'llm_error' };
  }

  let parsed: { problem?: unknown; why?: unknown; same_argument?: unknown };
  try { parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, '').trim()); }
  catch { return { choice: null, reason: 'unparseable' }; }

  const idx = Number(parsed.problem);
  // 0 means the picker found nothing in the facts pointing at any problem. That
  // is a real answer, not a failure: fall back to the model choosing from the
  // full menu, which is what it did before this existed.
  if (!Number.isInteger(idx) || idx < 1 || idx > problems.length) return { choice: null, reason: 'no_problem_fits' };

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
  };
}
