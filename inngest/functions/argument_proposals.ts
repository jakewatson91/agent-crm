/**
 * Weekly: read what each argument's messages did, and propose better wording
 * where the record says the argument itself is what went wrong.
 *
 * This is the only loop that touches the reason a message gets sent. The
 * drafter already learns from the same history, but it learns craft: it reads
 * recent decisions and adjusts the sentences of the next message. Measured on
 * the one workspace with real history, drafts fail on the argument rather than
 * the prose, so the existing loop was tuning the part that was not breaking.
 *
 * It proposes, it does not apply. Two reasons. The wording of an argument is the
 * single most load-bearing thing a customer ever types, and a model rewriting it
 * unattended is the same mistake as letting one write outreach unattended. And
 * accepting a proposal is itself an edit, which drops the confirmation and puts
 * the argument back to writing three messages and stopping, so a bad accept
 * costs three drafts rather than a book.
 *
 * Monday 16:00 UTC: after Sunday's advance pass has been decided on, and after
 * the 15:15 digest, so a proposal made today rides out in tomorrow's mail
 * rather than racing it.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { createServerClient } from '@agent-crm/db';
import {
  getPolicy, callTool, chatCompleteForWorkspace,
  loadArgumentRecords, worthProposing, whyQuestioned, renderOutcomeBlock,
  ARGUMENTS_PROMPT, sanitizeArguments,
  type DrafterArgument,
} from '@agent-crm/tools';
import { inngest } from '../client.ts';

/**
 * Same id `deriveArguments` pins for the wizard's call. This job runs the same
 * prompt on the same reasoning, so it runs on the same model. Changing either
 * one is a deliberate decision for whoever owns the model routing, not a
 * side effect of adding this job.
 */
const ARGUMENT_MODEL = 'deepseek-v4-flash';

/**
 * What the model is asked to do differently from setup. The setup prompt writes
 * arguments from a description of a product; here it rewrites one from what
 * happened when it was used, and the person's own words are the evidence.
 */
const REVIEW_SUFFIX = `
You are NOT writing a new argument from scratch. You are given one that has been
used on real companies, and what the seller said about the messages it produced.

Read their words as the correction they are. A message rejected as "the wrong
reason to write" says the chain itself does not hold at that company. A message
the seller rewrote before sending says the argument survived but something in it
was off, and their rewrite is the wording they wanted.

Change as little as possible. Keep what is working. If the record does not
actually say what is wrong, return the argument unchanged and say so in "why".

Output the same JSON shape, with exactly one argument in the list, keeping its
id, plus a "why" string of one plain sentence saying what you changed and what
in the record made you change it.`;

export async function runArgumentProposals(sb: SupabaseClient): Promise<Record<string, unknown>> {
  const wss = await sb.from('workspaces').select('id, name');
  if (wss.error) throw new Error(`workspaces query failed: ${wss.error.message}`);
  const out: Record<string, unknown> = {};

  for (const ws of (wss.data ?? []) as Array<{ id: string; name: string }>) {
    try {
      const policy = await getPolicy(sb, ws.id);
      const args = (policy.drafter?.arguments ?? []) as DrafterArgument[];
      if (!args.length) { out[ws.id] = { skipped: 'no arguments' }; continue; }

      const records = await loadArgumentRecords(sb, ws.id, args);
      const candidates = records.filter(worthProposing);
      if (!candidates.length) {
        out[ws.id] = { proposed: 0, why: records.map((r) => `${r.argument.id}: ${whyQuestioned(r)}`) };
        continue;
      }

      let next = args;
      const made: string[] = [];
      for (const rec of candidates) {
        const r = await chatCompleteForWorkspace(sb, ws.id, {
          // The same model the setup call already runs this same prompt on, so
          // this feature introduces no new model decision. Deliberately no
          // `behavior`: that would resolve to the workspace's drafter model,
          // which is chosen for writing prose a customer reads. This call reads
          // a record and rewrites config.
          model: ARGUMENT_MODEL,
          messages: [
            { role: 'system', content: ARGUMENTS_PROMPT + REVIEW_SUFFIX },
            { role: 'user', content: renderOutcomeBlock(rec) },
          ],
          response_format: { type: 'json_object' },
          max_tokens: 4000,
        });
        let parsed: unknown;
        try { parsed = JSON.parse(r.text); } catch { continue; }
        const [proposed] = sanitizeArguments(parsed);
        if (!proposed) continue;

        const why = typeof (parsed as { why?: unknown })?.why === 'string'
          ? (parsed as { why: string }).why.trim()
          : whyQuestioned(rec);

        // Unchanged wording is a real answer and must not become a proposal, or
        // the weekly mail says "we suggest this argument" every week forever.
        const same = proposed.when === rec.argument.when
          && (proposed.only_if ?? '') === (rec.argument.only_if ?? '')
          && proposed.so === rec.argument.so
          && proposed.ask === rec.argument.ask;
        if (same) continue;

        next = next.map((a) => a.id !== rec.argument.id ? a : {
          ...a,
          proposal: {
            when: proposed.when,
            ...(proposed.only_if ? { only_if: proposed.only_if } : {}),
            so: proposed.so,
            ask: proposed.ask,
            why,
            proposed_at: new Date().toISOString(),
          },
        });
        made.push(`${rec.argument.id}: ${why}`);
      }

      if (made.length) {
        // Through the config tool so the change is an ordinary audited write
        // with an undo, not a raw policy patch.
        await callTool(sb, { workspace_id: ws.id, actor_kind: 'system', actor_id: 'argument-proposals' },
          'update_workspace_config', {
            section: 'drafter.arguments',
            value: next,
            reasoning: `Weekly review proposed new wording: ${made.join('; ')}`,
          });
      }
      out[ws.id] = { proposed: made.length, detail: made };
    } catch (e) {
      out[ws.id] = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  return out;
}

export const argumentProposalsCron = inngest.createFunction(
  { id: 'argument-proposals', concurrency: { limit: 1 } },
  [{ cron: '0 16 * * 1' }, { event: 'argument_proposals.requested' }],
  async ({ step }) => step.run('review', async () => runArgumentProposals(createServerClient())),
);
