/**
 * Hacker News connector. Watches HN for posts mentioning workspace accounts.
 *
 * Config shape:
 *   {
 *     watch_entities?: [{ entity_id, name, aliases? }],  // optional override
 *     keywords?: string[],
 *     since_hours?: number,    // default 24
 *     min_points?: number      // default 0
 *   }
 *
 * Watch list resolution:
 *   - If watch_entities is non-empty in config, use it as-is (manual override).
 *   - Otherwise, pull every account in the workspace. New accounts discovered
 *     by other connectors (Exa, web, YC) get watched automatically on the
 *     next run. Users can add accounts via chat with the agent.
 */

import { callTool, fetchSeenSignalTags } from '@agent-crm/tools';
import type { Connector, ConnectorContext, ConnectorResult } from '../types.js';
import { getWatchedAccounts, matchAlias, buildAliases } from '../utils.js';

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

export { hnMeta as meta } from '../registry_meta.js';

const hn: Connector = async (ctx: ConnectorContext): Promise<ConnectorResult> => {
  const result: ConnectorResult = { signals_created: 0, entities_created: 0, skipped: 0, errors: [] };

  let watch = ((ctx.config.watch_entities as WatchEntity[]) ?? []);
  if (!watch.length) {
    // Dynamic watch list: every active (non-dropped) workspace account.
    // Picks up new entities from discovery + chat-added accounts automatically;
    // skips dropped fixtures so we don't waste signal-matching on stale rows.
    try {
      watch = await getWatchedAccounts(ctx.supabase, ctx.workspace_id);
    } catch (e) {
      result.errors.push(`failed to load workspace accounts: ${e instanceof Error ? e.message : String(e)}`);
      return result;
    }
    if (!watch.length) return result; // no accounts yet — no-op
  }
  const keywords = ((ctx.config.keywords as string[]) ?? []).filter(Boolean);
  const since_hours = (ctx.config.since_hours as number) ?? 24;
  const min_points = (ctx.config.min_points as number) ?? 0;

  // Build the Algolia narrowing query from keywords only. Joining N entity
  // names into an OR query blows past Algolia's URL/query-length limit once
  // the workspace has more than a few dozen accounts (the fallback list).
  // Post-filter the returned hits for entity mentions in the loop below.
  // If no keywords are configured, leave the query empty and let Algolia
  // return recent top stories filtered by min_points + since_hours.
  const query = keywords.map((q) => `"${q}"`).join(' OR ');
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
  const seenIdsRes = await fetchSeenSignalTags(ctx.supabase, {
    workspace_id: ctx.workspace_id,
    type: 'hn_mention',
    sinceISO: new Date(sinceUnix * 1000).toISOString(),
  });
  const seenStoryIds = new Set<string>();
  for (const r of seenIdsRes) {
    const sid = (r.structured_tags as { hn_story_id?: string } | null)?.hn_story_id;
    if (sid) seenStoryIds.add(sid);
  }

  for (const hit of hits) {
    if (seenStoryIds.has(hit.objectID)) { result.skipped++; continue; }
    const haystack = `${hit.title ?? ''} ${hit.url ?? ''} ${hit.story_text ?? ''}`;

    // Word-boundary alias match. Caller may have passed an explicit watch
    // list with name+aliases (legacy config) — derive aliases for those if
    // not pre-built; watch list from getWatchedAccounts already carries
    // a derived alias set.
    let matched: { entity_id: string; name: string; matched_alias: string } | null = null;
    for (const w of watch) {
      const aliases = ('aliases' in w && Array.isArray((w as any).aliases))
        ? (w as { aliases: string[] }).aliases
        : buildAliases(w.name, null);
      const aliasHit = matchAlias(haystack, aliases);
      if (aliasHit) { matched = { entity_id: w.entity_id, name: w.name, matched_alias: aliasHit }; break; }
    }
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
          source_id: ctx.source_id,
          hn_story_id: hit.objectID,
          hn_author: hit.author,
          hn_points: hit.points ?? 0,
          hn_url: hit.url,
          hn_tags: hit._tags,
          matched_alias: matched.matched_alias,
          matched_entity_name: matched.name,
          attribution_method: 'word_boundary',
        },
      },
    );
    if (r.ok) result.signals_created++;
    else result.errors.push(`create_signal failed for HN ${hit.objectID}: ${r.error}`);
  }

  return result;
};

export default hn;
