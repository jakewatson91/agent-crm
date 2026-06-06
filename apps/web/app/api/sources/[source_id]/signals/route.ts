import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';

export const runtime = 'nodejs';

export async function GET(req: Request, { params }: { params: Promise<{ source_id: string }> }) {
  const url = new URL(req.url);
  const workspace_id = url.searchParams.get('workspace_id');
  const { source_id } = await params;
  if (!workspace_id) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });

  const supabase = createServerClient();

  const { data: sigRows, error } = await supabase
    .from('signals')
    .select('id, type, body_for_embedding, magnitude, observed_at, created_at, entity_id, entities(name)')
    .eq('workspace_id', workspace_id)
    .filter('structured_tags->>source_id', 'eq', source_id)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (sigRows ?? []) as Array<{
    id: string;
    type: string;
    body_for_embedding: string | null;
    magnitude: number | null;
    observed_at: string | null;
    created_at: string;
    entity_id: string | null;
    entities: { name: string } | null;
  }>;

  if (!rows.length) return NextResponse.json({ signals: [] });

  // Check which signals have been matched to a subscription. Fetch all matched
  // events for this workspace (typically small) and filter client-side — the
  // same pattern used in recoverUnmatchedSignals.
  const signalIdSet = new Set(rows.map((r) => r.id));
  const { data: matchedEvts } = await supabase
    .from('events')
    .select('payload')
    .eq('workspace_id', workspace_id)
    .eq('action', 'subscription.matched')
    .limit(5000);

  const matched = new Set<string>(
    ((matchedEvts ?? []) as Array<{ payload: { signal_id?: string } | null }>)
      .map((e) => e.payload?.signal_id)
      .filter((id): id is string => !!id && signalIdSet.has(id)),
  );

  const signals = rows.map((r) => ({
    id: r.id,
    type: r.type,
    body: (r.body_for_embedding ?? '').slice(0, 120),
    magnitude: r.magnitude,
    entity_id: r.entity_id,
    entity_name: r.entities?.name ?? null,
    created_at: r.created_at,
    matched: matched.has(r.id),
  }));

  return NextResponse.json({ signals });
}
