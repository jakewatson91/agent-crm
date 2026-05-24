import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { ADMIN_PREDICATES } from '@agent-crm/tools/scoring';
import { resolveSourceSignalsBatch } from '../../../_lib/resolve_source_signal';

export const runtime = 'nodejs';

/**
 * Score timeline for an entity. Walks the full score_total history
 * (including superseded rows) and attributes each delta to the substantive
 * facts asserted in the window between adjacent score_total assertions.
 *
 * The bucketing model: a score_total asserted at time T was caused by every
 * non-admin fact whose created_at falls in (prior_score_total.created_at, T].
 * For the first score_total, the bucket is every non-admin fact at or before T.
 *
 * Each caused-by fact carries hop-0 source_signal so the UI can link
 * straight to the article without re-walking the chain.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ entity_id: string }> }) {
  const { entity_id } = await params;
  if (!entity_id) return NextResponse.json({ error: 'entity_id required' }, { status: 400 });

  const supabase = createServerClient();

  const ent = await supabase
    .from('entities')
    .select('id, workspace_id')
    .eq('id', entity_id)
    .maybeSingle();
  if (ent.error || !ent.data) {
    return NextResponse.json({ error: 'entity not found' }, { status: 404 });
  }
  const workspace_id = ent.data.workspace_id as string;

  const [scoresRes, factsRes] = await Promise.all([
    supabase
      .from('facts')
      .select('id, object_text, observed_at, created_at, supersedes')
      .eq('workspace_id', workspace_id)
      .eq('subject_entity', entity_id)
      .eq('predicate', 'score_total')
      .order('created_at', { ascending: true }),
    supabase
      .from('facts')
      .select('id, predicate, object_text, confidence, observed_at, created_at, source_event_id')
      .eq('workspace_id', workspace_id)
      .eq('subject_entity', entity_id)
      .order('created_at', { ascending: true }),
  ]);

  if (scoresRes.error) return NextResponse.json({ error: scoresRes.error.message }, { status: 500 });
  if (factsRes.error) return NextResponse.json({ error: factsRes.error.message }, { status: 500 });

  const scores = (scoresRes.data ?? []) as Array<{
    id: string;
    object_text: string | null;
    observed_at: string;
    created_at: string;
    supersedes: string | null;
  }>;

  const allFacts = (factsRes.data ?? []) as Array<{
    id: string;
    predicate: string;
    object_text: string | null;
    confidence: number;
    observed_at: string;
    created_at: string;
    source_event_id: number | null;
  }>;

  const substantive = allFacts.filter((f) => !ADMIN_PREDICATES.has(f.predicate));

  // Hydrate hop-0 source signal for every substantive fact in one batch
  // by walking parent_event_id chains.
  const startEventIds = Array.from(new Set(substantive.map((f) => f.source_event_id).filter((x): x is number => x != null)));
  const sigByEventId = await resolveSourceSignalsBatch(supabase, startEventIds, { enableHistoricalFallback: true });
  const sourceSignalByFactId = new Map<string, { source_name: string | null; source_url: string | null }>();
  for (const f of substantive) {
    if (f.source_event_id == null) continue;
    const sig = sigByEventId.get(f.source_event_id);
    if (sig) sourceSignalByFactId.set(f.id, sig);
  }

  // Bucket substantive facts into score_total windows.
  // Window i = (scores[i-1].created_at, scores[i].created_at]. For i=0, lower bound is -infinity.
  const factTs = substantive.map((f) => Date.parse(f.created_at));
  const entries = scores.map((s, i) => {
    const valueNum = parseFloat(s.object_text ?? '');
    const value = Number.isFinite(valueNum) ? valueNum : null;
    const prev = i > 0 ? scores[i - 1] : null;
    const prevValue = prev ? parseFloat(prev.object_text ?? '') : null;
    const delta = (value != null && prevValue != null && Number.isFinite(prevValue)) ? value - prevValue : null;

    const upper = Date.parse(s.created_at);
    const lower = prev ? Date.parse(prev.created_at) : -Infinity;
    const caused_by = substantive
      .filter((_, j) => {
        const t = factTs[j];
        return t !== undefined && t > lower && t <= upper;
      })
      .map((f) => ({
        fact_id: f.id,
        predicate: f.predicate,
        object_text: f.object_text,
        confidence: f.confidence,
        observed_at: f.observed_at,
        source_signal: sourceSignalByFactId.get(f.id) ?? null,
      }));

    return {
      at: s.created_at,
      value,
      delta,
      caused_by,
    };
  });

  return NextResponse.json({
    entity_id,
    entries,
    count: entries.length,
  });
}
