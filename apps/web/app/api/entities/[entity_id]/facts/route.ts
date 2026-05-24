import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { activeFacts } from '@agent-crm/primitives';

export const runtime = 'nodejs';

// Mirrors the families in /api/channels/[channel]/summary. Kept in sync by hand
// (small enough that duplicating beats threading a shared util through the
// summary route's local typing).
const FACT_FAMILIES: Array<{ name: string; match: (p: string) => boolean }> = [
  { name: 'firmographics', match: (p) => ['industry', 'stage', 'yc_status', 'yc_batch', 'is_hiring', 'team_size', 'location', 'domain'].includes(p) },
  { name: 'scoring',       match: (p) => p.startsWith('score_') || p === 'icp_fit' || p === 'icp_fit_breakdown' },
  { name: 'engagement',    match: (p) => ['dropped_until', 'research_triggered', 'contact_lookup_attempted', 'works_at', 'email', 'role'].includes(p) },
];
function familyOf(predicate: string): string {
  for (const f of FACT_FAMILIES) if (f.match(predicate)) return f.name;
  return 'other';
}

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

  const facts = await activeFacts(supabase, ent.data.workspace_id as string, entity_id);

  const grouped: Record<string, typeof facts> = {};
  for (const f of facts) {
    const fam = familyOf(f.predicate);
    (grouped[fam] ||= []).push(f);
  }

  return NextResponse.json({
    entity_id,
    count: facts.length,
    grouped,
  });
}
