/**
 * Product Hunt connector.
 *
 * Fetches today's launches via PH GraphQL. For each launch, checks if its name,
 * tagline, makers, or domain match any watched entity. Emits a signal on match.
 *
 * Auth: PH GraphQL needs a developer token (PRODUCTHUNT_TOKEN env). Without it
 * the connector skips with an error in last_run_summary.
 *
 * Config shape:
 *   {
 *     watch_entities: [...],
 *     since_hours?: number,    // default 24
 *     min_votes?: number,      // default 0
 *   }
 */

import { callTool, fetchSeenSignalTags } from '@agent-crm/tools';
import type { Connector, ConnectorContext, ConnectorResult } from '../types.js';

interface WatchEntity { entity_id: string; name: string; aliases?: string[] }

interface PhPost {
  id: string;
  name: string;
  tagline: string;
  description: string | null;
  url: string;
  website: string | null;
  votesCount: number;
  createdAt: string;
  makers: { name: string; username: string }[];
  topics: { nodes: { name: string }[] };
}

export { producthuntMeta as meta } from '../registry_meta.js';

const QUERY = `query Posts($postedAfter: DateTime) {
  posts(postedAfter: $postedAfter, order: VOTES, first: 50) {
    edges {
      node {
        id
        name
        tagline
        description
        url
        website
        votesCount
        createdAt
        makers { name username }
        topics(first: 10) { nodes { name } }
      }
    }
  }
}`;

const ph: Connector = async (ctx: ConnectorContext): Promise<ConnectorResult> => {
  const result: ConnectorResult = { signals_created: 0, entities_created: 0, skipped: 0, errors: [] };
  const token = process.env.PRODUCTHUNT_TOKEN;
  if (!token) { result.errors.push('PRODUCTHUNT_TOKEN env is not set'); return result; }

  const watch = ((ctx.config.watch_entities as WatchEntity[]) ?? []);
  if (!watch.length) { result.errors.push('config.watch_entities is empty'); return result; }
  const since_hours = (ctx.config.since_hours as number) ?? 24;
  const min_votes = (ctx.config.min_votes as number) ?? 0;
  const postedAfter = new Date(Date.now() - since_hours * 3600 * 1000).toISOString();

  let posts: PhPost[];
  try {
    const r = await fetch('https://api.producthunt.com/v2/api/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query: QUERY, variables: { postedAfter } }),
    });
    if (!r.ok) { result.errors.push(`PH ${r.status}: ${(await r.text()).slice(0, 200)}`); return result; }
    const j = await r.json() as { data?: { posts?: { edges: { node: PhPost }[] } } };
    posts = j.data?.posts?.edges.map((e) => e.node) ?? [];
  } catch (e) {
    result.errors.push(`PH fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }

  // Dedup
  const cutoff = Date.now() - since_hours * 3600 * 1000;
  const seen = await fetchSeenSignalTags(ctx.supabase, {
    workspace_id: ctx.workspace_id,
    type: 'producthunt_launch',
    sinceISO: new Date(cutoff).toISOString(),
  });
  const seenIds = new Set<string>();
  for (const s of seen) {
    const id = (s.structured_tags as { ph_post_id?: string } | null)?.ph_post_id;
    if (id) seenIds.add(id);
  }

  for (const p of posts) {
    if (p.votesCount < min_votes) { result.skipped++; continue; }
    if (seenIds.has(p.id)) { result.skipped++; continue; }
    const haystack = `${p.name} ${p.tagline} ${p.description ?? ''} ${p.website ?? ''} ${p.makers.map((m) => `${m.name} ${m.username}`).join(' ')}`.toLowerCase();
    const matched = watch.find((w) => {
      const cands = [w.name, ...(w.aliases ?? [])].filter(Boolean).map((s) => s.toLowerCase());
      return cands.some((c) => haystack.includes(c));
    });
    if (!matched) { result.skipped++; continue; }

    const r = await callTool(
      ctx.supabase,
      { workspace_id: ctx.workspace_id, actor_kind: 'agent', actor_id: `source:ph:${ctx.source_id.slice(0, 8)}` },
      'create_signal',
      {
        entity_id: matched.entity_id,
        type: 'producthunt_launch',
        magnitude: Math.min(0.9, 0.4 + Math.log10(p.votesCount + 1) / 4),
        body_for_embedding: `[Product Hunt] ${p.name} — ${p.tagline}. ${p.description?.slice(0, 200) ?? ''} (${p.votesCount} votes) ${p.url}`,
        structured_tags: {
          signal_source: 'producthunt',
          source_id: ctx.source_id,
          ph_post_id: p.id,
          ph_url: p.url,
          ph_website: p.website,
          ph_votes: p.votesCount,
          ph_topics: p.topics.nodes.map((t) => t.name),
          ph_makers: p.makers.map((m) => m.username),
          matched_alias: matched.name,
        },
      },
    );
    if (r.ok) result.signals_created++;
    else result.errors.push(`create_signal failed: ${r.error}`);
  }

  return result;
};

export default ph;
