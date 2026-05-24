import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { getEntityTypes } from '@agent-crm/tools';

export const runtime = 'nodejs';

interface TimelineItem {
  ts: string;
  kind: 'signal' | 'fact' | 'post' | 'gate';
  id: string;
  summary: string;
  detail: Record<string, unknown>;
}

/**
 * Unified activity timeline for a channel's account.
 * Merges signals (about the account), facts asserted (on the account), channel
 * posts, and gates into one chronological stream. This is the "the system runs
 * itself" view — drag through it and see every agent action that happened.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ channel: string }> }) {
  const { channel } = await params;
  const supabase = createServerClient();

  const ch = await supabase.from('channels').select('id, title, account_entity_id, workspace_id').eq('id', channel).maybeSingle();
  if (ch.error || !ch.data) return NextResponse.json({ error: 'channel not found' }, { status: 404 });
  const account_id = ch.data.account_entity_id as string;
  const ws_id = ch.data.workspace_id as string;

  const ent = await supabase.from('entities').select('name, attributes').eq('id', account_id).maybeSingle();
  const entKinds = await getEntityTypes(supabase, account_id);
  const entityWithKind = ent.data ? { ...ent.data, kind: entKinds[0] ?? 'entity', types: entKinds } : null;

  const [signals, facts, posts, gates] = await Promise.all([
    supabase.from('signals').select('id, type, magnitude, body_for_embedding, observed_at, structured_tags').eq('entity_id', account_id).order('observed_at', { ascending: false }).limit(50),
    supabase.from('facts').select('id, predicate, object_text, confidence, observed_at, source_event_id, supersedes').eq('subject_entity', account_id).order('observed_at', { ascending: false }).limit(100),
    supabase.from('channel_posts').select('id, kind, body, cites, author_kind, author_id, created_at, parent_post_id').eq('channel_id', channel).order('created_at', { ascending: false }).limit(100),
    supabase.from('gates').select('id, requested_by_agent, policy, condition, requested_at, decision, decided_at, channel_post_id').eq('workspace_id', ws_id).order('requested_at', { ascending: false }).limit(50),
  ]);

  // Compute "active" facts (not superseded)
  const factRows = facts.data ?? [];
  const supersededIds = new Set(factRows.map((f) => f.supersedes).filter((x): x is string => !!x));

  const items: TimelineItem[] = [];

  for (const s of signals.data ?? []) {
    const tags = (s.structured_tags as Record<string, unknown>) ?? {};
    items.push({
      ts: s.observed_at as string,
      kind: 'signal',
      id: s.id as string,
      summary: `${s.type} · mag=${s.magnitude}`,
      detail: {
        body: s.body_for_embedding,
        signal_source: tags.signal_source ?? null,
        item_url: tags.item_url ?? tags.hn_url ?? tags.yc_url ?? null,
        type: s.type,
      },
    });
  }

  for (const f of factRows) {
    items.push({
      ts: f.observed_at as string,
      kind: 'fact',
      id: f.id as string,
      summary: `${f.predicate} = ${f.object_text}`,
      detail: {
        confidence: f.confidence,
        source_event_id: f.source_event_id,
        active: !supersededIds.has(f.id as string),
        superseded: !!f.supersedes,
      },
    });
  }

  for (const p of posts.data ?? []) {
    items.push({
      ts: p.created_at as string,
      kind: 'post',
      id: p.id as string,
      summary: `${p.kind} by ${p.author_kind}/${p.author_id}`,
      detail: {
        body: p.body,
        cites: p.cites,
        post_kind: p.kind,
        author_id: p.author_id,
        parent_post_id: p.parent_post_id,
      },
    });
  }

  // Gates that reference posts in THIS channel
  const channelPostIds = new Set((posts.data ?? []).map((p) => p.id as string));
  for (const g of gates.data ?? []) {
    if (!g.channel_post_id || !channelPostIds.has(g.channel_post_id as string)) continue;
    items.push({
      ts: g.requested_at as string,
      kind: 'gate',
      id: g.id as string,
      summary: `gate · ${g.policy}${g.decision ? ` · decided=${g.decision}` : ' · pending'}`,
      detail: {
        requested_by: g.requested_by_agent,
        policy: g.policy,
        condition: g.condition,
        decision: g.decision,
        channel_post_id: g.channel_post_id,
      },
    });
  }

  items.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));  // newest first

  return NextResponse.json({
    channel: ch.data,
    entity: entityWithKind,
    items: items.slice(0, 200),
    counts: {
      signals: signals.data?.length ?? 0,
      facts: factRows.length,
      posts: posts.data?.length ?? 0,
      gates: gates.data?.length ?? 0,
    },
  });
}
