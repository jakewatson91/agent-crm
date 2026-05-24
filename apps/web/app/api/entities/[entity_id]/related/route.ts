import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { relatedToEntity, entitiesFromSubject } from '@agent-crm/primitives';

export const runtime = 'nodejs';

/**
 * Entities related to this one, both directions:
 *   inbound  — facts where object_entity = this  (e.g. contacts pointing AT this account)
 *   outbound — facts where subject_entity = this (e.g. accounts a contact works at)
 *
 * Workspace is resolved from the entity itself. Active (non-superseded) facts only.
 */
export async function GET(req: Request, { params }: { params: Promise<{ entity_id: string }> }) {
  const { entity_id } = await params;
  if (!entity_id) return NextResponse.json({ error: 'entity_id required' }, { status: 400 });

  const supabase = createServerClient();

  const ent = await supabase
    .from('entities')
    .select('id, workspace_id, kind')
    .eq('id', entity_id)
    .maybeSingle();
  if (ent.error || !ent.data) {
    return NextResponse.json({ error: 'entity not found' }, { status: 404 });
  }
  const workspace_id = ent.data.workspace_id as string;

  const [inbound, outbound] = await Promise.all([
    relatedToEntity(supabase, workspace_id, entity_id),
    entitiesFromSubject(supabase, workspace_id, entity_id),
  ]);

  return NextResponse.json({
    entity: { id: ent.data.id, kind: ent.data.kind },
    inbound,
    outbound,
  });
}
