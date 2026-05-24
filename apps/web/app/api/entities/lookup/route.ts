import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { lookupEntity } from '@agent-crm/tools/reads';

export const dynamic = 'force-dynamic';

/**
 * Sidebar search backend. Fuzzy-matches entity name within a workspace and
 * returns enough to render a result + jump to the entity's channel.
 *
 * Limits to 8 matches because the UI is an inline dropdown, not a results page.
 */
export async function GET(req: NextRequest) {
  const ws = req.nextUrl.searchParams.get('workspace_id');
  const q = req.nextUrl.searchParams.get('q') ?? '';
  if (!ws) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });
  if (!q.trim()) return NextResponse.json({ matches: [] });

  const sb = createServerClient();
  const matches = await lookupEntity(sb, ws, { name: q, fuzzy: true, limit: 8 });
  if (!matches.length) return NextResponse.json({ matches: [] });

  // Join channel_id + latest icp_fit so the row can jump straight to the
  // entity timeline and show its current score.
  const ids = matches.map((m) => m.entity_id);
  const [chans, fits] = await Promise.all([
    sb.from('channels').select('id, account_entity_id').eq('workspace_id', ws).in('account_entity_id', ids),
    sb.from('facts').select('id, subject_entity, object_text, supersedes')
      .eq('workspace_id', ws).eq('predicate', 'icp_fit').in('subject_entity', ids),
  ]);

  const channelByEntity = new Map<string, string>();
  for (const c of (chans.data ?? []) as Array<{ id: string; account_entity_id: string }>) {
    channelByEntity.set(c.account_entity_id, c.id);
  }
  // Latest fit = fit not referenced as `supersedes` by any other fit fact.
  const supersededIds = new Set<string>(((fits.data ?? []) as any[]).map((f) => f.supersedes).filter(Boolean));
  const fitByEntity = new Map<string, number>();
  for (const f of (fits.data ?? []) as Array<{ id: string; subject_entity: string; object_text: string }>) {
    if (supersededIds.has(f.id)) continue;
    const v = parseFloat(f.object_text);
    if (!Number.isFinite(v)) continue;
    if (!fitByEntity.has(f.subject_entity)) fitByEntity.set(f.subject_entity, v);
  }

  return NextResponse.json({
    matches: matches.map((m) => ({
      entity_id: m.entity_id,
      name: m.name,
      kind: m.kind,
      channel_id: channelByEntity.get(m.entity_id) ?? null,
      icp_fit: fitByEntity.get(m.entity_id) ?? null,
    })),
  });
}
