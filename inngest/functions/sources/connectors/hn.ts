/**
 * Hacker News connector. Watches HN for posts mentioning configured entities.
 *
 * Config shape:
 *   {
 *     watch_entities: [{ entity_id: uuid, name: string, aliases?: string[] }],
 *     keywords?: string[],           // optional additional free-text query terms
 *     since_hours?: number,          // default 24
 *     min_points?: number            // default 0
 *   }
 *
 * Approach:
 *   1. Build a single HN Algolia search query from `keywords` + entity names + aliases.
 *   2. Fetch hits since (now - since_hours) hours.
 *   3. For each hit, find the first watch_entity whose name/alias appears in title or URL.
 *   4. Create a signal tied to that entity_id. Skip hits that match no tracked entity.
 *   5. Idempotent: skip hits that already produced a signal (deduped by HN story_id in structured_tags).
 */

import { callTool } from '@agent-crm/tools';
import type { Connector, ConnectorContext, ConnectorResult, ConnectorMeta } from '../types.js';

interface HnHit {
  objectID: string;       // story id
  title: string | null;
  url: string | null;
  story_text: string | null;
  comment_text: string | null;
  author: string;
  points: number | null;
  num_comments: number | null;
  created_at: string;
  created_at_i: number;   // unix
  _tags: string[];
}

interface WatchEntity { entity_id: string; name: string; aliases?: string[] }

export const meta: ConnectorMeta = {
  type: 'hn',
  label: 'Hacker News',
  description: 'Watch HN for posts mentioning specific companies. Uses the free Algolia search API.',
  category: 'preset',
  emits_signal_source: 'hn',
  schedule_cron: '0 * * * *',  // hourly
  config_schema: {
    fields: [
      {
        name: 'watch_entities',
        label: 'Companies to watch',
        kind: 'entity_picker_multi',
        required: true,
        help: 'Pick existing accounts in your workspace. The connector will create a signal whenever HN mentions any of them.',
      },
      {
        name: 'keywords',
        label: 'Additional keywords (optional)',
        kind: 'string_array',
        help: 'Comma-separated. Narrows the HN search before entity matching. Leave empty for no narrowing.',
      },
      {
        name: 'since_hours',
        label: 'Look back (hours)',
        kind: 'number',
        default: 24,
        help: 'Fetch posts created in the last N hours.',
      },
      {
        name: 'min_points',
        label: 'Minimum HN points',
        kind: 'number',
        default: 0,
        help: 'Skip posts below this score. Set higher to reduce noise.',
      },
    ],
  },
};

const hn: Connector = async (ctx: ConnectorContext): Promise<ConnectorResult> => {
  const result: ConnectorResult = { signals_created: 0, entities_created: 0, skipped: 0, errors: [] };

  const watch = ((ctx.config.watch_entities as WatchEntity[]) ?? []);
  if (!watch.length) {
    result.errors.push('config.watch_entities is empty — nothing to match against');
    return result;
  }
  const keywords = ((ctx.config.keywords as string[]) ?? []).filter(Boolean);
  const since_hours = (ctx.config.since_hours as number) ?? 24;
  const min_points = (ctx.config.min_points as number) ?? 0;

  // Build search query: union of entity names + extra keywords. HN Algolia supports OR via parens.
  const queryTerms = [
    ...watch.flatMap((w) => [w.name, ...(w.aliases ?? [])]),
    ...keywords,
  ].filter(Boolean);
  const query = queryTerms.map((q) => `"${q}"`).join(' OR ');
  const sinceUnix = Math.floor(Date.now() / 1000) - since_hours * 3600;

  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&numericFilters=created_at_i>${sinceUnix},points>=${min_points}&hitsPerPage=100`;

  let hits: HnHit[] = [];
  try {
    const r = await fetch(url);
    if (!r.ok) {
      result.errors.push(`HN Algolia ${r.status}: ${await r.text()}`);
      return result;
    }
    const j = await r.json() as { hits: HnHit[] };
    hits = j.hits ?? [];
  } catch (e) {
    result.errors.push(`HN fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }

  // Pre-fetch existing signals from this source's history to dedupe by HN story id.
  const seenIdsRes = await ctx.supabase
    .from('signals')
    .select('structured_tags')
    .eq('workspace_id', ctx.workspace_id)
    .eq('type', 'hn_mention')
    .gte('observed_at', new Date(sinceUnix * 1000).toISOString());
  const seenStoryIds = new Set<string>();
  for (const r of seenIdsRes.data ?? []) {
    const sid = (r.structured_tags as { hn_story_id?: string } | null)?.hn_story_id;
    if (sid) seenStoryIds.add(sid);
  }

  for (const hit of hits) {
    if (seenStoryIds.has(hit.objectID)) { result.skipped++; continue; }
    const haystack = `${hit.title ?? ''} ${hit.url ?? ''} ${hit.story_text ?? ''}`.toLowerCase();
    const matched = watch.find((w) => {
      const candidates = [w.name, ...(w.aliases ?? [])].filter(Boolean).map((s) => s.toLowerCase());
      return candidates.some((c) => haystack.includes(c));
    });
    if (!matched) { result.skipped++; continue; }

    const body = `[HN] ${hit.title ?? '(no title)'} (${hit.points ?? 0} points, ${hit.num_comments ?? 0} comments) ${hit.url ?? ''}`;
    const r = await callTool(
      ctx.supabase,
      { workspace_id: ctx.workspace_id, actor_kind: 'agent', actor_id: `source:hn:${ctx.source_id.slice(0, 8)}` },
      'create_signal',
      {
        entity_id: matched.entity_id,
        type: 'hn_mention',
        magnitude: Math.min(0.9, 0.3 + Math.log10((hit.points ?? 0) + 1) / 3),
        body_for_embedding: body,
        structured_tags: {
          signal_source: 'hn',
          hn_story_id: hit.objectID,
          hn_author: hit.author,
          hn_points: hit.points ?? 0,
          hn_url: hit.url,
          hn_tags: hit._tags,
          matched_alias: matched.name,
        },
      },
    );
    if (r.ok) result.signals_created++;
    else result.errors.push(`create_signal failed for HN ${hit.objectID}: ${r.error}`);
  }

  return result;
};

export default hn;
