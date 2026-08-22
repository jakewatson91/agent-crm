/**
 * Derive this workspace's arguments from the same plain-English `about` the
 * rest of the wizard reads.
 *
 * Why this is separate from _derive_defaults. Everything that file produces is
 * a COMPONENT of a message: who to talk to, what to research, what problems the
 * product solves, what may be claimed, what shape the message takes. None of
 * them is the argument, so the drafter had to work out the link on every single
 * message from a paragraph that describes how the product works. On Sudden it
 * reached the same wrong conclusion 26 times in a week, and the fix was to type
 * the argument into a one-off script by hand, which no customer can do.
 *
 * Asked as its own call with its own instructions, the model gets it right. Two
 * reasons it is a separate call rather than four more keys on the existing one:
 * the reasoning is different (work out where the benefit concentrates, then find
 * the event that creates that concentration, rather than summarise), and this
 * one has to be re-runnable on its own from Settings after a customer edits
 * their About, without regenerating the ICP and quietly rescoring the book.
 *
 * Safety comes from `proven_at` being left unset. A derived argument is a guess
 * about someone's market, so the drafter writes three messages under it and
 * stops until a human confirms it. A wrong guess costs three drafts.
 */
import { chatComplete } from '@agent-crm/primitives';
import type { DrafterArgument } from '@agent-crm/tools';

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

export async function deriveArguments(about: string): Promise<DrafterArgument[]> {
  try {
    const r = await chatComplete({
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: ARGUMENTS_PROMPT },
        { role: 'user', content: `Customer description:\n${about}` },
      ],
      response_format: { type: 'json_object' },
      // Deliberately roomy, and deliberately NOT thinking:'disabled'. Working
      // out where a product's benefit concentrates, then which event creates
      // that condition, is the reasoning this whole call exists to do, so the
      // thinking earns its tokens here in a way it does not on a labeller. But
      // thinking is billed against this same ceiling: at 1600 one run in two
      // came back as an empty string, having spent the entire budget before
      // writing any JSON. Runs once per workspace, so the tokens are cheap.
      max_tokens: 4000,
    });
    return sanitizeArguments(JSON.parse(r.text));
  } catch {
    // No arguments configured is a supported state: the drafter falls back to
    // picking a problem from pain_points, which is what every workspace did
    // before this existed.
    return [];
  }
}
