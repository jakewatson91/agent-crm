/**
 * Per-workspace entity index, pre-aggregated for the /workspace/[ws]/entities page.
 *
 * Returns the entities the page renders, the latest ICP-fit per entity, and the
 * last agent activity per account — all in one round trip. Output shape uses
 * arrays-of-entries (not Maps) so SWR can cache + serialize the payload cleanly.
 */
import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';

export const runtime = 'nodejs';

interface EntityRow {
  id: string;
  types: string[];
  name: string;
  attributes: Record<string, unknown>;
  updated_at: string;
}

interface Activity {
  ts: string;
  kind: string;
}

interface EntitiesPageData {
  entities: EntityRow[];
  icpEntries: Array<[string, number]>;
  lastActivityEntries: Array<[string, Activity]>;
}

const ARTICLE_SUFFIX = /\s(story|guide|tips|trends|outlooks?|insights|review|reviews|news)$/i;
const ARTICLE_PREFIX = /^(best|top|how\s+to|why|what\s+is|guide\s+to|the\s+ultimate|the\s+best|the\s+top)\b/i;

function isJunkName(name: string, domain: string, publicationBlocklist: string[]): boolean {
  const n = name.trim();
  if (n.length < 2) return true;
  const isMultiWord = /\s/.test(n);
  if (!isMultiWord && n === n.toLowerCase() && n.length > 3) return true;
  if (isMultiWord && n === n.toLowerCase()) return true;
  if (!isMultiWord) {
    if (/^[A-Z]{2,}[a-z]/.test(n)) return true;
    if (n.length > 14) return true;
  }
  if (isMultiWord) {
    const words = n.split(/\s+/);
    if (words.length >= 5) return true;
    if (ARTICLE_SUFFIX.test(n)) return true;
    if (words.length >= 4 && ARTICLE_PREFIX.test(n)) return true;
  }
  if (publicationBlocklist.length) {
    const lower = n.toLowerCase();
    for (const b of publicationBlocklist) {
      if (b && lower === b.trim().toLowerCase()) return true;
    }
  }
  if (domain) {
    const d = domain.toLowerCase();
    if ((d.includes('news') || d.includes('blog') || d.includes('report') || d.includes('today')) && !/^[A-Z]/.test(n)) {
      return true;
    }
  }
  return false;
}

const getEntitiesPageData = async (ws: string): Promise<EntitiesPageData> => {
  const supabase = createServerClient();

  // Round 1: workspace policy + entities are independent — fire together.
  const [policyRow, entitiesRes] = await Promise.all([
    supabase.from('workspaces').select('policy').eq('id', ws).maybeSingle(),
    supabase
      .from('entities')
      .select('id, name, attributes, updated_at, archived_at')
      .eq('workspace_id', ws)
      .is('archived_at', null)
      .order('name'),
  ]);
  const publicationBlocklist = (((policyRow.data?.policy as Record<string, unknown> | null)?.publication_blocklist) as string[] | undefined ?? []).filter(Boolean);
  const rawEntities = ((entitiesRes.data ?? []) as Array<{ id: string; name: string; attributes: Record<string, unknown>; updated_at: string }>).filter((e) => {
    const dom = (e.attributes?.['domain'] as string | undefined) ?? '';
    if (dom.endsWith('.example')) return false;
    if (isJunkName(e.name, dom, publicationBlocklist)) return false;
    return true;
  });

  const ids = rawEntities.map((e) => e.id);

  // Round 1.5: types come from is_a facts. Batch in one query.
  const typesByEntity = new Map<string, string[]>();
  if (ids.length) {
    const { data: typeFacts } = await supabase.from('facts')
      .select('subject_entity, object_text')
      .eq('workspace_id', ws)
      .eq('predicate', 'is_a')
      .is('supersedes', null)
      .in('subject_entity', ids);
    for (const f of (typeFacts ?? []) as Array<{ subject_entity: string; object_text: string | null }>) {
      if (!f.object_text) continue;
      const arr = typesByEntity.get(f.subject_entity) ?? [];
      arr.push(f.object_text);
      typesByEntity.set(f.subject_entity, arr);
    }
  }
  const entities: EntityRow[] = rawEntities.map((e) => ({
    ...e,
    types: typesByEntity.get(e.id) ?? [],
  }));

  const accountIds = entities.filter((e) => e.types.includes('account')).map((e) => e.id);

  // Round 2: facts (icp_fit per entity) + channels (per account) are independent.
  const icpMap = new Map<string, number>();
  const lastActivity = new Map<string, Activity>();
  const [factsRes, chansRes] = await Promise.all([
    ids.length
      ? supabase.from('facts').select('subject_entity, object_text, supersedes, id').eq('workspace_id', ws).eq('predicate', 'icp_fit').in('subject_entity', ids)
      : Promise.resolve({ data: [] as unknown[] }),
    accountIds.length
      ? supabase.from('channels').select('id, account_entity_id').eq('workspace_id', ws).in('account_entity_id', accountIds)
      : Promise.resolve({ data: [] as unknown[] }),
  ]);

  const superseded = new Set(
    ((factsRes.data ?? []) as Array<{ supersedes: string | null }>).map((f) => f.supersedes).filter(Boolean) as string[],
  );
  for (const f of (factsRes.data ?? []) as Array<{ subject_entity: string; object_text: string; id: string }>) {
    if (superseded.has(f.id)) continue;
    const v = parseFloat(f.object_text);
    if (!isNaN(v) && !icpMap.has(f.subject_entity)) icpMap.set(f.subject_entity, v);
  }

  // Round 3: last agent activity needs channel IDs from round 2.
  const channelToEntity = new Map<string, string>();
  for (const c of (chansRes.data ?? []) as Array<{ id: string; account_entity_id: string }>) {
    channelToEntity.set(c.id, c.account_entity_id);
  }
  const channelIds = [...channelToEntity.keys()];
  if (channelIds.length) {
    const { data: posts } = await supabase
      .from('channel_posts')
      .select('channel_id, kind, created_at')
      .in('channel_id', channelIds)
      .order('created_at', { ascending: false })
      .limit(Math.max(200, channelIds.length * 3));
    for (const p of (posts ?? []) as Array<{ channel_id: string; kind: string; created_at: string }>) {
      const entId = channelToEntity.get(p.channel_id);
      if (!entId || lastActivity.has(entId)) continue;
      lastActivity.set(entId, { ts: p.created_at, kind: p.kind });
    }
  }

  return {
    entities,
    icpEntries: [...icpMap.entries()],
    lastActivityEntries: [...lastActivity.entries()],
  };
};

export async function GET(req: Request) {
  const url = new URL(req.url);
  const ws = url.searchParams.get('workspace_id');
  if (!ws) return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });
  const data = await getEntitiesPageData(ws);
  return NextResponse.json(data);
}
