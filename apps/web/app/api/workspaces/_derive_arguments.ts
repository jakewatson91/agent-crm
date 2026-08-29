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
// Moved into the tools package so the weekly proposer can reuse the same prompt
// and the same bounds. Re-exported here so the wizard, the create route and
// scripts/_dryrun_arguments.ts keep importing from where they always have.
import { ARGUMENTS_PROMPT, sanitizeArguments } from '@agent-crm/tools/derive_arguments';
export { ARGUMENTS_PROMPT, sanitizeArguments };

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
