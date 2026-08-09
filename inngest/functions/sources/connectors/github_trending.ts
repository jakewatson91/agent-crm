/**
 * GitHub Trending connector.
 *
 * Searches public repos via `https://api.github.com/search/repositories` with
 * a config-driven query (topic + language + recency), then post-filters the
 * results for mentions of any workspace entity in the description, owner login,
 * or top-level repo name. Each matching repo emits a `github_trending` signal
 * on the matched entity.
 *
 * Cross-source diversity is the point: a YC company that's been silent on its
 * own GitHub org might show up as a contributor or namechecked in someone
 * else's trending repo description — exactly the kind of "they're building
 * AI infra" signal we want.
 *
 * Auth: optional. Unauthenticated = 60 req/hr; authenticated = 5000 req/hr.
 * If GITHUB_TOKEN env is set, uses it.
 *
 * Config:
 *   {
 *     watch_entities?: [{ entity_id, name, aliases? }],  // optional override; falls back to all accounts
 *     topics?: string[],                                  // GitHub topics, e.g. ['ai-agents','llm']
 *     language?: string,                                  // e.g. 'python'
 *     pushed_since?: string,                              // ISO date or 'YYYY-MM-DD'; default 30d ago
 *     min_stars?: number,                                 // default 25
 *     max_results?: number,                               // default 100
 *   }
 */

import { callTool, entityIdsOfType, fetchSeenSignalTags } from '@agent-crm/tools';
import type { Connector, ConnectorContext, ConnectorResult } from '../types.ts';

interface WatchEntity { entity_id: string; name: string; aliases?: string[] }

interface GhRepo {
  id: number;
  full_name: string;
  name: string;
  description: string | null;
  html_url: string;
  stargazers_count: number;
  pushed_at: string;
  language: string | null;
  owner: { login: string; html_url: string };
  topics?: string[];
}

export { githubTrendingMeta as meta } from '../registry_meta.ts';

function buildQuery(cfg: { topics?: string[]; language?: string; pushed_since?: string; min_stars?: number }): string {
  const parts: string[] = [];
  for (const t of cfg.topics ?? []) parts.push(`topic:${t}`);
  if (cfg.language) parts.push(`language:${cfg.language}`);
  const since = cfg.pushed_since && /^\d{4}-\d{2}-\d{2}/.test(cfg.pushed_since)
    ? cfg.pushed_since.slice(0, 10)
    : new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10);
  parts.push(`pushed:>${since}`);
  if ((cfg.min_stars ?? 0) > 0) parts.push(`stars:>=${cfg.min_stars}`);
  return parts.join(' ');
}

const githubTrending: Connector = async (ctx: ConnectorContext): Promise<ConnectorResult> => {
  const result: ConnectorResult = { signals_created: 0, entities_created: 0, skipped: 0, errors: [] };

  // Resolve watch list: config override, else every workspace account.
  let watch = ((ctx.config.watch_entities as WatchEntity[]) ?? []);
  if (!watch.length) {
    const acctIds = (await entityIdsOfType(ctx.supabase, ctx.workspace_id, 'account')).slice(0, 2000);
    const acctRes = acctIds.length === 0
      ? { data: [] as Array<{ id: string; name: string }>, error: null as null }
      : await ctx.supabase.from('entities')
          .select('id, name').in('id', acctIds);
    if (acctRes.error) {
      result.errors.push(`failed to load workspace accounts: ${acctRes.error.message}`);
      return result;
    }
    watch = ((acctRes.data ?? []) as Array<{ id: string; name: string }>)
      .map((r) => ({ entity_id: r.id, name: r.name }));
    if (!watch.length) return result;
  }

  const max = (ctx.config.max_results as number) ?? 100;
  const query = buildQuery(ctx.config as Record<string, unknown>);
  if (!query.includes('topic:') && !query.includes('language:')) {
    result.errors.push('config needs at least one topic or a language to narrow the search');
    return result;
  }

  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    'User-Agent': 'agent-crm/github-trending',
    Accept: 'application/vnd.github+json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  // GitHub caps search at 100 per page; one request is enough for our scale.
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${Math.min(max, 100)}`;
  let repos: GhRepo[];
  try {
    const r = await fetch(url, { headers });
    if (!r.ok) {
      result.errors.push(`gh search ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return result;
    }
    const j = await r.json() as { items?: GhRepo[] };
    repos = j.items ?? [];
  } catch (e) {
    result.errors.push(`gh search failed: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }

  // Dedup against signals already emitted for the same (entity, repo) pair.
  const since30d = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
  const seenRes = await fetchSeenSignalTags(ctx.supabase, {
    workspace_id: ctx.workspace_id,
    type: 'github_trending',
    sinceISO: since30d,
  });
  const seenPairs = new Set<string>();
  for (const s of seenRes as Array<{ entity_id: string; structured_tags: { gh_repo?: string } | null }>) {
    const repo = s.structured_tags?.gh_repo;
    if (repo) seenPairs.add(`${s.entity_id}::${repo}`);
  }

  // Precompute lowercased haystacks so the inner loop is just a substring scan.
  const watchTerms: Array<{ entity: WatchEntity; terms: string[] }> = watch.map((w) => ({
    entity: w,
    terms: [w.name, ...(w.aliases ?? [])].filter(Boolean).map((s) => s.toLowerCase()),
  }));

  for (const repo of repos) {
    const haystack = `${repo.name} ${repo.full_name} ${repo.owner.login} ${repo.description ?? ''}`.toLowerCase();
    // First match wins — if multiple entities match the same repo, we emit one signal on the first.
    const matched = watchTerms.find(({ terms }) => terms.some((t) => t.length >= 3 && haystack.includes(t)));
    if (!matched) { result.skipped++; continue; }
    const pair = `${matched.entity.entity_id}::${repo.full_name}`;
    if (seenPairs.has(pair)) { result.skipped++; continue; }

    const body = `[GitHub trending] ${repo.full_name} (${repo.stargazers_count}★) — ${repo.description ?? '(no description)'}. Mentions ${matched.entity.name}.`;
    const r = await callTool(
      ctx.supabase,
      { workspace_id: ctx.workspace_id, actor_kind: 'agent', actor_id: `source:github_trending:${ctx.source_id.slice(0, 8)}` },
      'create_signal',
      {
        entity_id: matched.entity.entity_id,
        type: 'github_trending',
        magnitude: 0.55,
        body_for_embedding: body,
        structured_tags: {
          signal_source: 'github_trending',
          source_id: ctx.source_id,
          gh_repo: repo.full_name,
          gh_repo_url: repo.html_url,
          gh_stars: repo.stargazers_count,
          gh_language: repo.language,
          gh_owner: repo.owner.login,
          matched_term: matched.terms.find((t) => haystack.includes(t)) ?? matched.entity.name,
        },
      },
    );
    if (r.ok) result.signals_created++;
    else result.errors.push(`create_signal failed: ${r.error}`);
  }

  return result;
};

export default githubTrending;
