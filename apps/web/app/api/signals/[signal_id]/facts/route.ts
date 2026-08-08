import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { resolveEntityNames } from '../../../_lib/resolve_entity_names';

export const runtime = 'nodejs';

/**
 * Facts a given signal produced — the answer to "what did this page actually
 * teach the agent". Unlike /api/entities/[entity_id]/facts (a current-state
 * read via activeFacts()), this is a historical read: it returns every fact
 * ever tied to this signal_id, including ones later superseded, because "the
 * agent found 3 facts here" is a statement about this specific research pass,
 * not about what's true right now.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ signal_id: string }> }) {
  const { signal_id } = await params;
  if (!signal_id) return NextResponse.json({ error: 'signal_id required' }, { status: 400 });

  const supabase = createServerClient();

  const sig = await supabase
    .from('signals')
    .select('workspace_id')
    .eq('id', signal_id)
    .maybeSingle();
  if (sig.error || !sig.data) {
    return NextResponse.json({ error: 'signal not found' }, { status: 404 });
  }

  const { data, error } = await supabase
    .from('facts')
    .select('id, subject_entity, predicate, object_text, object_entity, confidence, observed_at')
    .eq('signal_id', signal_id)
    .order('observed_at', { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const facts = data ?? [];
  const entityIds = facts.flatMap((f) => [f.subject_entity, f.object_entity].filter((x): x is string => !!x));
  const nameByEntityId = await resolveEntityNames(supabase, entityIds);

  const hydrated = facts.map((f) => ({
    ...f,
    subject_entity_name: nameByEntityId.get(f.subject_entity) ?? null,
    object_entity_name: f.object_entity ? (nameByEntityId.get(f.object_entity) ?? null) : null,
  }));

  return NextResponse.json({ signal_id, count: hydrated.length, facts: hydrated });
}
