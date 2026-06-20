import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { resolveSourceSignalsBatch } from '../../_lib/resolve_source_signal';
import { resolveEntityNames } from '../../_lib/resolve_entity_names';

export const runtime = 'nodejs';

/**
 * Batch-hydrate facts by id. Used by WhyThis to show the cited facts inline.
 * RLS scopes the select; we don't need to pass workspace_id explicitly.
 *
 * Each fact also carries `source_signal` — hop-0 of the provenance chain —
 * so the WhyThis row can link straight to the article that produced the
 * claim without forcing the user to walk the full chain.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const ids = (url.searchParams.get('ids') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) return NextResponse.json({ facts: [] });

  const supabase = createServerClient();
  const { data, error } = await supabase
    .from('facts')
    .select('id, predicate, object_text, confidence, observed_at, subject_entity, object_entity, source_event_id')
    .in('id', ids);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const facts = (data ?? []) as Array<{
    id: string;
    predicate: string;
    object_text: string | null;
    confidence: number;
    observed_at: string;
    subject_entity: string | null;
    object_entity: string | null;
    source_event_id: number | null;
  }>;

  const startEventIds = Array.from(new Set(facts.map((f) => f.source_event_id).filter((x): x is number => x != null)));
  // When a fact's object IS another entity, resolve its name so the UI can link
  // to it instead of showing a bare UUID.
  const objectEntityIds = Array.from(new Set(facts.map((f) => f.object_entity).filter((x): x is string => !!x)));
  const [sigByEventId, nameByEntityId] = await Promise.all([
    resolveSourceSignalsBatch(supabase, startEventIds, { enableHistoricalFallback: true }),
    resolveEntityNames(supabase, objectEntityIds),
  ]);

  const hydrated = facts.map((f) => ({
    ...f,
    object_entity_name: f.object_entity ? (nameByEntityId.get(f.object_entity) ?? null) : null,
    source_signal: (f.source_event_id != null ? sigByEventId.get(f.source_event_id) : null) ?? null,
  }));

  return NextResponse.json({ facts: hydrated });
}
