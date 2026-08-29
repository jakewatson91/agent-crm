/**
 * The messages each argument has actually written, for the settings screen.
 *
 * The confirm checkbox on an argument says "I have read the drafts this wrote."
 * Until this route existed the screen never showed them, so the customer was
 * asked to vouch for messages they had no way to see from that page. This
 * returns them, and the same count the drafter itself uses to decide whether an
 * argument has hit its limit and stopped.
 */
import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { UNPROVEN_ARGUMENT_DRAFT_LIMIT, type DrafterArgument } from '@agent-crm/tools';

export const runtime = 'nodejs';

type PostRow = {
  id: string;
  body: string;
  created_at: string;
  argument_id: string | null;
  channels: { workspace_id: string; entity: { name: string } | null };
};

export type ArgumentDraft = {
  id: string;
  account: string | null;
  body: string;
  created_at: string;
  /** 'pending' while nobody has decided, else the human's answer. */
  state: 'pending' | 'approved' | 'rejected';
};

export type ArgumentDrafts = {
  /** Drafts written under the current wording, newest first. */
  drafts: ArgumentDraft[];
  /** What the drafter counts against the limit: written minus rejected. */
  counted: number;
  limit: number;
};

export async function GET(req: Request) {
  const url = new URL(req.url);
  const ws = url.searchParams.get('workspace_id');
  if (!ws) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });

  const supabase = createServerClient();
  const { data: wsRow, error: wsErr } = await supabase
    .from('workspaces').select('policy').eq('id', ws).single();
  if (wsErr) return NextResponse.json({ error: wsErr.message }, { status: 500 });

  const policy = (wsRow?.policy ?? {}) as { drafter?: { arguments?: DrafterArgument[] } };
  const args = (policy.drafter?.arguments ?? []).filter((a) => a?.id);
  if (!args.length) return NextResponse.json({ arguments: {}, accounts: 0 });

  // What confirming actually turns loose. "Use this on the whole book" means
  // nothing without the size of the book next to it.
  //
  // Counted off the is_a fact, not off entities: the live table has no `kind`
  // column (0001_init declared one, the schema in front of us does not), so
  // filtering on it is a PostgREST 400 and the number silently comes back null.
  // Verified on Sudden: 1961 active is_a=account facts, 1961 distinct subjects,
  // so one fact per account and this count is not inflated by a fact chain.
  const { count: accounts } = await supabase
    .from('facts')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', ws).eq('predicate', 'is_a').eq('object_text', 'account')
    .is('supersedes', null);

  // Scoped through the join for the same reason the drafter scopes it: argument
  // ids are short per-workspace slugs and two customers will collide on them.
  const { data, error } = await supabase
    .from('channel_posts')
    .select('id, body, created_at, argument_id, channels!inner(workspace_id, entity:entities(name))')
    .eq('channels.workspace_id', ws)
    .eq('kind', 'touch_draft')
    .in('argument_id', args.map((a) => a.id))
    .is('withdrawn_at', null)
    .order('created_at', { ascending: false })
    .limit(300);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const rows = (data ?? []) as unknown as PostRow[];

  // A rejection is a human having looked and said no, so it does not spend the
  // argument's allowance — matching the drafter, which would otherwise leave a
  // fully-rejected argument stuck at its limit with no way forward.
  const decisions = new Map<string, 'approved' | 'rejected'>();
  if (rows.length) {
    const { data: gates } = await supabase
      .from('gates')
      .select('channel_post_id, decision')
      .eq('workspace_id', ws)
      .in('channel_post_id', rows.map((r) => r.id));
    for (const g of gates ?? []) {
      const d = (g as { channel_post_id: string; decision: string | null });
      if (d.decision === 'approve') decisions.set(d.channel_post_id, 'approved');
      else if (d.decision === 'reject') decisions.set(d.channel_post_id, 'rejected');
    }
  }

  const out: Record<string, ArgumentDrafts> = {};
  for (const a of args) {
    const since = a.words_changed_at ? Date.parse(a.words_changed_at) : 0;
    const drafts: ArgumentDraft[] = rows
      .filter((r) => r.argument_id === a.id && Date.parse(r.created_at) >= since)
      .map((r) => ({
        id: r.id,
        account: r.channels?.entity?.name ?? null,
        body: r.body,
        created_at: r.created_at,
        state: decisions.get(r.id) ?? 'pending',
      }));
    out[a.id] = {
      drafts,
      counted: drafts.filter((d) => d.state !== 'rejected').length,
      limit: UNPROVEN_ARGUMENT_DRAFT_LIMIT,
    };
  }

  return NextResponse.json({ arguments: out, accounts: accounts ?? 0 });
}
