/**
 * Read what an argument's messages actually did, and decide whether there is
 * enough there to be worth proposing a rewrite.
 *
 * Split from the scheduled job so the judgement is testable without a cron and
 * without an LLM call. The job runs weekly; this decides whether that week's
 * run has anything to say.
 *
 * The signal this reads did not exist until the reject button started asking
 * what KIND of wrong a draft was. Before that a rejection carried free text,
 * and on the one workspace with real history those read "this is terrible" and
 * "just a jumble of points in a sentence without any flow" — complaints about
 * two different layers that need opposite fixes. Rewriting an argument because
 * someone disliked a sentence is how a working argument gets destroyed.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DraftVerdict } from './draft_verdict.ts';
import type { DrafterArgument } from './policy.ts';

/** What one decided draft told us about the argument behind it. */
export interface ArgumentOutcome {
  account: string;
  decision: 'approve' | 'reject' | 'modify';
  verdict?: DraftVerdict;
  /** The note the person typed, if any. */
  note?: string;
  /** What they changed on the way to approving it. The strongest signal there is. */
  edit?: string;
  decided_at: string;
}

export interface ArgumentRecord {
  argument: DrafterArgument;
  outcomes: ArgumentOutcome[];
  approved: number;
  /** Rejections that blamed the argument itself, not the company or the prose. */
  wrong_reason: number;
  wrong_company: number;
  bad_writing: number;
  edits: number;
}

/**
 * Enough evidence to be worth a model call.
 *
 * Two ways in. Someone said the reason was wrong more than once, or someone
 * kept rewriting the message before sending it. One rejection is a bad account,
 * not a bad argument, and proposing a rewrite off a single no would make the
 * weekly mail noise inside a month.
 */
export const MIN_WRONG_REASON = 2;
export const MIN_EDITS = 3;

export function worthProposing(r: ArgumentRecord): boolean {
  return r.wrong_reason >= MIN_WRONG_REASON || r.edits >= MIN_EDITS;
}

/**
 * Say in one line why this argument is being questioned, for the person who has
 * to decide. "3 of its messages were rejected as the wrong reason" is a finding.
 * "Performance has degraded" is not.
 */
export function whyQuestioned(r: ArgumentRecord): string {
  const bits: string[] = [];
  if (r.wrong_reason) bits.push(`${r.wrong_reason} message${r.wrong_reason === 1 ? '' : 's'} rejected as the wrong reason to write`);
  if (r.edits) bits.push(`${r.edits} rewritten before sending`);
  if (r.approved) bits.push(`${r.approved} approved as written`);
  return bits.join(', ') || 'no decisions yet';
}

/**
 * Gather each argument's record over a window.
 *
 * Scoped through the channel join for the same reason every other read of this
 * table is: argument ids are short per-workspace slugs and two customers will
 * collide on them.
 */
export async function loadArgumentRecords(
  supabase: SupabaseClient,
  workspace_id: string,
  args: DrafterArgument[],
  sinceDays = 90,
): Promise<ArgumentRecord[]> {
  const live = args.filter((a) => a?.id && a.enabled !== false);
  if (!live.length) return [];
  const since = new Date(Date.now() - sinceDays * 86400_000).toISOString();

  const { data: postRows } = await supabase
    .from('channel_posts')
    .select('id, created_at, argument_id, channels!inner(workspace_id, entity:entities(name))')
    .eq('channels.workspace_id', workspace_id)
    .eq('kind', 'touch_draft')
    .in('argument_id', live.map((a) => a.id))
    .is('withdrawn_at', null)
    .gte('created_at', since);
  const posts = (postRows ?? []) as unknown as Array<{
    id: string; created_at: string; argument_id: string;
    channels: { entity: { name: string } | null };
  }>;
  if (!posts.length) return live.map((a) => emptyRecord(a));

  const { data: gateRows } = await supabase
    .from('gates')
    .select('channel_post_id, decision, decided_at, resolution')
    .eq('workspace_id', workspace_id)
    .in('channel_post_id', posts.map((p) => p.id))
    .not('decided_at', 'is', null);
  const gates = new Map((gateRows ?? []).map((g) => {
    const row = g as { channel_post_id: string; decision: string; decided_at: string; resolution: Record<string, unknown> | null };
    return [row.channel_post_id, row];
  }));

  return live.map((a) => {
    const rec = emptyRecord(a);
    for (const p of posts) {
      if (p.argument_id !== a.id) continue;
      // A wording change makes it a different argument, so its old messages are
      // not evidence about the words in front of us.
      if (a.words_changed_at && p.created_at < a.words_changed_at) continue;
      const g = gates.get(p.id);
      if (!g) continue;
      const res = (g.resolution ?? {}) as { verdict?: DraftVerdict; note?: string; body_diff?: unknown; final_body?: unknown; edited?: unknown };
      const edited = Boolean(res.edited || res.body_diff || res.final_body);
      const outcome: ArgumentOutcome = {
        account: p.channels?.entity?.name ?? '(unknown)',
        decision: g.decision as ArgumentOutcome['decision'],
        ...(res.verdict ? { verdict: res.verdict } : {}),
        ...(typeof res.note === 'string' && res.note.trim() ? { note: res.note.trim() } : {}),
        ...(edited && typeof res.final_body === 'string' ? { edit: res.final_body } : {}),
        decided_at: g.decided_at,
      };
      rec.outcomes.push(outcome);
      if (outcome.decision === 'reject') {
        if (outcome.verdict === 'wrong_reason') rec.wrong_reason++;
        else if (outcome.verdict === 'wrong_company') rec.wrong_company++;
        else if (outcome.verdict === 'bad_writing') rec.bad_writing++;
      } else {
        rec.approved++;
        if (edited) rec.edits++;
      }
    }
    rec.outcomes.sort((x, y) => y.decided_at.localeCompare(x.decided_at));
    return rec;
  });
}

function emptyRecord(argument: DrafterArgument): ArgumentRecord {
  return { argument, outcomes: [], approved: 0, wrong_reason: 0, wrong_company: 0, bad_writing: 0, edits: 0 };
}

/**
 * The evidence block handed to the model, alongside the prompt that already
 * writes arguments at setup. Deliberately the person's own words: their note is
 * what they meant, and a summary of it would be this job guessing twice.
 */
export function renderOutcomeBlock(r: ArgumentRecord): string {
  const a = r.argument;
  const lines = [
    'THE ARGUMENT AS IT STANDS:',
    `  when    : ${a.when}`,
    ...(a.only_if ? [`  only if : ${a.only_if}`] : []),
    `  so      : ${a.so}`,
    `  ask     : ${a.ask}`,
    '',
    `WHAT ITS MESSAGES DID: ${whyQuestioned(r)}`,
    '',
  ];
  for (const o of r.outcomes.slice(0, 12)) {
    const verdict = o.decision === 'reject' ? `REJECTED (${o.verdict ?? 'no reason given'})` : 'APPROVED';
    lines.push(`- ${o.account}: ${verdict}`);
    if (o.note) lines.push(`    they said: ${o.note.slice(0, 300)}`);
    if (o.edit) lines.push(`    they rewrote it to: ${o.edit.slice(0, 600)}`);
  }
  return lines.join('\n');
}
