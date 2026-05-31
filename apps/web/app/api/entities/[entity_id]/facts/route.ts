import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { activeFacts } from '@agent-crm/primitives';
import { getPolicy, factFamilyOf } from '@agent-crm/tools';

export const runtime = 'nodejs';

/**
 * Thin facts read for any entity kind. Account pages use /api/channels/[id]/summary
 * which bundles facts with posts/history; non-account kinds (contact, product)
 * use this lighter route.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ entity_id: string }> }) {
  const { entity_id } = await params;
  if (!entity_id) return NextResponse.json({ error: 'entity_id required' }, { status: 400 });

  const supabase = createServerClient();

  const ent = await supabase
    .from('entities')
    .select('workspace_id')
    .eq('id', entity_id)
    .maybeSingle();
  if (ent.error || !ent.data) {
    return NextResponse.json({ error: 'entity not found' }, { status: 404 });
  }

  const workspace_id = ent.data.workspace_id as string;
  const facts = await activeFacts(supabase, workspace_id, entity_id);

  const policy = await getPolicy(supabase, workspace_id);
  const groups = policy.display?.fact_groups ?? [];
  const grouped: Record<string, typeof facts> = {};
  for (const f of facts) {
    const fam = factFamilyOf(f.predicate, groups);
    (grouped[fam] ||= []).push(f);
  }

  return NextResponse.json({
    entity_id,
    count: facts.length,
    grouped,
  });
}
