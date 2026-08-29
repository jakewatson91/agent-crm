/**
 * The prompt that writes a workspace's arguments, and the coercion that keeps
 * the model's answer inside what the drafter can run.
 *
 * Lives here rather than beside the setup wizard because two callers need it
 * now: the wizard, which writes arguments from the customer's own description,
 * and the weekly proposer, which rewrites them from what the messages they
 * produced actually did. Same reasoning, different evidence.
 *
 * `deriveArguments` itself stays in the web app: it pins its own model for the
 * one-off wizard call, and scripts/check_model_routing.ts whitelists it there
 * by path.
 */
import type { DrafterArgument } from './policy.ts';

export const ARGUMENTS_PROMPT = `You are setting up outbound sales for a new customer. You have their own description of what they sell. Write down the arguments their best salesperson would make.

An argument is not a description of the product, and it is not a list of problems. It is one chain of cause and effect about the PROSPECT'S business, in four parts:

- "when": a dated event at the prospect, findable from outside the company. A launch, a hire, a filing, a page appearing on their own site. An event with a date, never a standing condition.
- "only_if": something separately true about the prospect that has to hold before the claim below is honest, and that can be checked without the event. Test it: could a company have the "when" and not have this? If no, rewrite it or leave it out.
- "so": what the event costs THEM, in terms of their business. Not what the product does.
- "ask": the one change being asked for. Not "book a call", not "reply if interested".

HOW TO FIND ONE. The description tells you where the product's benefit is concentrated: conditions under which it pays off far more than average. Find that condition, then work out which EVENT at a company creates it. That event is the "when", and what it costs them is the "so".

RULES.
- Keep the ask small enough that a stranger would agree to it in a first message, and leave alone whatever they cannot afford to have go wrong.
- Use only what the description supports. Never invent numbers, customer names, case studies or track record.
- Plain English. Short sentences. Nothing a normal person would not say out loud.
- Between 1 and 3 arguments.

Output strictly valid JSON in this shape:
{"arguments":[{"id":"short_snake_case_slug","label":"short line naming the argument","when":"...","only_if":"...","so":"...","ask":"..."}]}`;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Coerce one raw model response into arguments the drafter can run.
 *
 * Exported so scripts/_dryrun_arguments.ts can grade the prompt, and so the
 * bounds can be pinned without an LLM call. An argument missing `when`, `so` or
 * `ask` is dropped rather than repaired: those three are the chain, and a
 * half-argument would be picked up and used like a whole one.
 */
export function sanitizeArguments(raw: unknown): DrafterArgument[] {
  const list = (raw as { arguments?: unknown })?.arguments;
  if (!Array.isArray(list)) return [];
  const out: DrafterArgument[] = [];
  const seen = new Set<string>();
  for (const item of list as Array<Record<string, unknown>>) {
    const when = str(item?.when), so = str(item?.so), ask = str(item?.ask);
    if (!when || !so || !ask) continue;
    const id = (str(item?.id) || str(item?.label) || 'argument')
      .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'argument';
    if (seen.has(id)) continue;
    seen.add(id);
    const only_if = str(item?.only_if);
    out.push({
      id,
      label: str(item?.label) || id,
      when,
      ...(only_if ? { only_if } : {}),
      so,
      ask,
      // Never set here. A derived argument has never met a real account, so the
      // drafter writes three messages under it and waits for a human. This is
      // the whole reason it is safe to let a model write these at all.
      enabled: true,
    });
  }
  // Three is already more than the drafter can sensibly choose between on one
  // account, and each unproven one spends its own three drafts before stopping.
  return out.slice(0, 3);
}

