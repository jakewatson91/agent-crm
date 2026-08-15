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

  // The generated types model an embedded relation as an ARRAY, so asserting it
  // to a single object here did not overlap and failed the build. Accept both
  // shapes and normalize once — a to-one embed comes back as an object at
  // runtime, but the declared type is the array, and the consumer below only
  // wants the name.
  const rawRows = (sigRows ?? []) as unknown as Array<{
    id: string;
    type: string;
    body_for_embedding: string | null;
    magnitude: number | null;
    observed_at: string | null;
    created_at: string;
    entity_id: string | null;
    entities: { name: string } | Array<{ name: string }> | null;
  }>;
  const rows = rawRows.map((r) => ({
    ...r,
    entities: (Array.isArray(r.entities) ? r.entities[0] : r.entities) ?? null,
  }));

  if (!rows.length) return NextResponse.json({ signals: [] });

  // Check which signals matched at least one subscription. The matcher now
  // writes a subscription.matched marker for EVERY processed signal (matched or
  // not), so "matched" here means matched_count > 0 — not merely "the matcher
  // ran." Legacy rows predate matched_count; treat a missing field as truthy so
  // old genuinely-matched signals still show correctly.
  //
  // Scoped to the signals on this page. Reading every marker in the workspace
  // and filtering here stopped at PostgREST's 1000 rows, and this workspace has
  // had thousands of markers since June, so the ones belonging to the signals
  // actually on screen were usually not in the 1000 that came back and every
  // signal showed as unmatched. The marker's target_id IS the signal_id, which
  // is the same lookup recoverUnmatchedSignals was fixed to use.
  const signalIds = rows.map((r) => r.id);
  const { data: matchedEvts } = await supabase
    .from('events')
    .select('target_id, payload')
    .eq('workspace_id', workspace_id)
    .eq('action', 'subscription.matched')
    .in('target_id', signalIds);

  const matched = new Set<string>(
    ((matchedEvts ?? []) as Array<{ target_id: string | null; payload: { signal_id?: string; matched_count?: number } | null }>)
      .filter((e) => {
        const c = e.payload?.matched_count;
        return c === undefined || c > 0;
      })
      .map((e) => e.payload?.signal_id ?? e.target_id)
      .filter((id): id is string => !!id),
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
