import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';

export const dynamic = 'force-dynamic';

const STALE_SIGNAL_MIN = 30;
const STALE_GATE_DAYS = 7;
const STALE_DRAFT_DAYS = 7;

export async function GET(req: NextRequest) {
  const ws = req.nextUrl.searchParams.get('workspace_id');
  if (!ws) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });
  const sb = createServerClient();

  // 1. unmatched signals (signals older than threshold with no subscription.matched event)
  const sigCutoff = new Date(Date.now() - STALE_SIGNAL_MIN * 60 * 1000).toISOString();
  const sigs = await sb.from('signals').select('id').eq('workspace_id', ws).lt('created_at', sigCutoff).limit(500);
  const sigIds = (sigs.data ?? []).map((r) => r.id as string);
  let unmatched = 0;
  if (sigIds.length) {
    const matched = await sb.from('events')
      .select('payload')
      .eq('workspace_id', ws)
      .eq('action', 'subscription.matched');
    const matchedSet = new Set<string>();
    for (const e of matched.data ?? []) {
      const p = (e.payload ?? {}) as { signal_id?: string };
      if (p.signal_id) matchedSet.add(p.signal_id);
    }
    unmatched = sigIds.filter((id) => !matchedSet.has(id)).length;
  }

  // 2. sources currently in error state
  const errSrc = await sb.from('sources')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', ws)
    .eq('last_run_status', 'error');
  const erroredSources = errSrc.count ?? 0;

  // 3. open gates older than threshold
  const gateCutoff = new Date(Date.now() - STALE_GATE_DAYS * 86400000).toISOString();
  const gateReqs = await sb.from('events')
    .select('id')
    .eq('workspace_id', ws)
    .eq('action', 'request_gate')
    .lt('ts', gateCutoff)
    .limit(200);
  const gateIds = new Set<number>((gateReqs.data ?? []).map((g) => g.id as number));
  let staleGates = 0;
  if (gateIds.size) {
    const decided = await sb.from('events')
      .select('parent_event_id')
      .eq('workspace_id', ws)
      .eq('action', 'gate_decision');
    const decidedSet = new Set<number>();
    for (const d of decided.data ?? []) {
      const v = d.parent_event_id as number | null;
      if (v) decidedSet.add(v);
    }
    for (const gid of gateIds) if (!decidedSet.has(gid)) staleGates++;
  }

  // 4. drafts older than threshold with no follow-up
  const draftCutoff = new Date(Date.now() - STALE_DRAFT_DAYS * 86400000).toISOString();
  const drafts = await sb.from('channel_posts')
    .select('id, channel_id')
    .eq('kind', 'touch_draft')
    .lt('created_at', draftCutoff)
    .limit(200);
  let staleDrafts = 0;
  const draftRows = drafts.data ?? [];
  if (draftRows.length) {
    const channelIds = [...new Set(draftRows.map((d) => d.channel_id as string))];
    const followups = await sb.from('channel_posts')
      .select('channel_id')
      .in('channel_id', channelIds)
      .gt('created_at', draftCutoff);
    const channelsWithFollow = new Set<string>((followups.data ?? []).map((p) => p.channel_id as string));
    staleDrafts = draftRows.filter((d) => !channelsWithFollow.has(d.channel_id as string)).length;
  }

  return NextResponse.json({
    unmatched_signals: unmatched,
    errored_sources: erroredSources,
    stale_gates: staleGates,
    stale_drafts: staleDrafts,
  });
}
