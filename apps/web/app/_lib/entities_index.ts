/**
 * Shared entities-index pipeline for /workspace/[ws]/entities (SSR) and
 * /api/entities/index. One implementation, one 5-minute cache (tag
 * 'entities'), so the server-rendered page and the client's SWR revalidate
 * hit the same cached result instead of each re-running the queries.
 */
import { unstable_cache } from 'next/cache';
import { createServerClient } from '@agent-crm/db';
import { fetchAll } from '@agent-crm/tools';

export interface EntityRow {
  id: string;
  types: string[];
  name: string;
  attributes: Record<string, unknown>;
  updated_at: string;
}

export interface Activity {
  ts: string;
  kind: string;
}

export interface EntitiesPageData {
  entities: EntityRow[];
  icpEntries: Array<[string, number]>;
  lastActivityEntries: Array<[string, Activity]>;
  cooldownEntries: Array<[string, string]>;
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

const _getEntitiesPageData = async (ws: string): Promise<EntitiesPageData> => {
  const supabase = createServerClient();

  // Round 1: fire all workspace-scoped reads in parallel — no entity IDs needed.
  // All three scale with entity count and silently truncated at the PostgREST 1000-row
  // cap once a workspace crossed 1000 entities — so entities late in the name order (and
  // their types/scores) vanished from the page and its client-side search. Page them all.
  const [policyRow, entityRows, typeFactRows, fitFactRows] = await Promise.all([
    supabase.from('workspaces').select('policy').eq('id', ws).maybeSingle(),
    fetchAll<{ id: string; name: string; attributes: Record<string, unknown>; updated_at: string }>((from, to) =>
      supabase.from('entities')
        .select('id, name, attributes, updated_at, archived_at')
        .eq('workspace_id', ws).is('archived_at', null).order('name').range(from, to)),
    fetchAll<{ subject_entity: string; object_text: string | null }>((from, to) =>
      supabase.from('facts').select('subject_entity, object_text')
        .eq('workspace_id', ws).eq('predicate', 'is_a').is('supersedes', null).range(from, to)),
    fetchAll<{ subject_entity: string; object_text: string; id: string }>((from, to) =>
      supabase.from('facts').select('subject_entity, object_text, id')
        .eq('workspace_id', ws).eq('predicate', 'icp_fit').is('supersedes', null).range(from, to)),
  ]);

  const publicationBlocklist = (((policyRow.data?.policy as Record<string, unknown> | null)?.publication_blocklist) as string[] | undefined ?? []).filter(Boolean);
  const rawEntities = entityRows.filter((e) => {
    const dom = (e.attributes?.['domain'] as string | undefined) ?? '';
    if (dom.endsWith('.example')) return false;
    if (isJunkName(e.name, dom, publicationBlocklist)) return false;
    return true;
  });

  const ids = new Set(rawEntities.map((e) => e.id));

  const typesByEntity = new Map<string, string[]>();
  for (const f of typeFactRows) {
    if (!f.object_text || !ids.has(f.subject_entity)) continue;
    const arr = typesByEntity.get(f.subject_entity) ?? [];
    arr.push(f.object_text);
    typesByEntity.set(f.subject_entity, arr);
  }
  const entities: EntityRow[] = rawEntities.map((e) => ({
    ...e,
    types: typesByEntity.get(e.id) ?? [],
  }));

  const accountIds = entities.filter((e) => e.types.includes('account')).map((e) => e.id);

  // Round 2: channels + active cooldowns depend on entity ids derived above. Fetch all
  // workspace channels (paged) and filter in memory — a `.in()` over 1000+ account ids
  // blows past the PostgREST URL limit and silently returns nothing.
  const icpMap = new Map<string, number>();
  const lastActivity = new Map<string, Activity>();
  const accountIdSet = new Set(accountIds);
  const [allChannels, cooldownRes] = await Promise.all([
    accountIds.length
      ? fetchAll<{ id: string; account_entity_id: string }>((from, to) =>
          supabase.from('channels').select('id, account_entity_id').eq('workspace_id', ws).range(from, to))
      : Promise.resolve([] as Array<{ id: string; account_entity_id: string }>),
    supabase.from('facts')
      .select('subject_entity, object_text')
      .eq('workspace_id', ws)
      .eq('predicate', 'outreach_cooldown_until')
      .is('supersedes', null),
  ]);
  const chans = allChannels.filter((c) => accountIdSet.has(c.account_entity_id));

  for (const f of fitFactRows) {
    if (!ids.has(f.subject_entity)) continue;
    const v = parseFloat(f.object_text);
    if (!isNaN(v) && !icpMap.has(f.subject_entity)) icpMap.set(f.subject_entity, v);
  }

  // Round 3: last agent activity needs channel IDs from round 2. Chunk the channel_id
  // `.in()` so a workspace with 1000+ channels doesn't overflow the URL. Each channel
  // lives in exactly one chunk and its posts come back newest-first, so the first post
  // seen per channel is its most recent.
  const channelToEntity = new Map<string, string>();
  for (const c of chans) channelToEntity.set(c.id, c.account_entity_id);
  const channelIds = [...channelToEntity.keys()];
  const CH_CHUNK = 200;
  for (let i = 0; i < channelIds.length; i += CH_CHUNK) {
    const chunk = channelIds.slice(i, i + CH_CHUNK);
    const { data: posts } = await supabase
      .from('channel_posts')
      .select('channel_id, kind, created_at')
      .in('channel_id', chunk)
      .order('created_at', { ascending: false })
      .limit(Math.max(200, chunk.length * 3));
    for (const p of (posts ?? []) as Array<{ channel_id: string; kind: string; created_at: string }>) {
      const entId = channelToEntity.get(p.channel_id);
      if (!entId || lastActivity.has(entId)) continue;
      lastActivity.set(entId, { ts: p.created_at, kind: p.kind });
    }
  }

  const now = new Date().toISOString();
  const cooldownMap = new Map<string, string>();
  for (const f of (cooldownRes.data ?? []) as Array<{ subject_entity: string; object_text: string }>) {
    if (ids.has(f.subject_entity) && f.object_text > now) {
      cooldownMap.set(f.subject_entity, f.object_text);
    }
  }

  return {
    entities,
    icpEntries: [...icpMap.entries()],
    lastActivityEntries: [...lastActivity.entries()],
    cooldownEntries: [...cooldownMap.entries()],
  };
};

export const getEntitiesPageData = unstable_cache(
  _getEntitiesPageData,
  ['entities-page'],
  { revalidate: 300, tags: ['entities'] },
);
