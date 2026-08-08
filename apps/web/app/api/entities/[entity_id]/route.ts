import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';

export const runtime = 'nodejs';

/**
 * Bare entity identity read: name, kind, attributes. The full entity page
 * (workspace/[ws]/entities/[entity_id]/page.tsx) fetches this same shape
 * server-side directly; this route exposes it to client components — the
 * drawer needs to open an entity without a full page navigation.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ entity_id: string }> }) {
  const { entity_id } = await params;
  if (!entity_id) return NextResponse.json({ error: 'entity_id required' }, { status: 400 });

  const supabase = createServerClient();

  const [entityRes, typeRes] = await Promise.all([
    supabase.from('entities').select('id, name, attributes').eq('id', entity_id).maybeSingle(),
    supabase
      .from('facts')
      .select('object_text')
      .eq('subject_entity', entity_id)
      .eq('predicate', 'is_a')
      .is('supersedes', null)
      .limit(1)
      .maybeSingle(),
  ]);
  if (entityRes.error || !entityRes.data) {
    return NextResponse.json({ error: 'entity not found' }, { status: 404 });
  }

  return NextResponse.json({
    id: entityRes.data.id,
    name: entityRes.data.name,
    kind: typeRes.data?.object_text ?? 'entity',
    attributes: (entityRes.data.attributes ?? {}) as Record<string, unknown>,
  });
}
