/**
 * Exa connector. Semantic + keyword web search returning rendered page contents.
 *
 * Solves the JS-hydration problem (raw HTML fetch returns empty shells on most
 * modern sites). Use this for discovery across the open web, especially for:
 *   - Listings or directories (job boards, marketplaces, listings sites)
 *   - News / blog mentions
 *   - Competitor research
 *   - Anything where you'd reach for "what's been written recently about X"
 *
 * Auth: requires EXA_API_KEY env. ~$0.005 per search.
 *
 * Two intents (same as the web connector):
 *   - discover (default when watch_entities is empty): extract company per result, dedupe-or-create entity
 *   - watch:    only emit signals on results mentioning a known watched entity
 *
 * Config:
 *   {
 *     query: string                  // required
 *     include_domains?: string[]
 *     exclude_domains?: string[]
 *     num_results?: number           // default 25
 *     since_hours?: number           // default 168 (1 week)
 *     intent?: 'discover' | 'watch'  // default 'discover' if no watch_entities, else 'watch'
 *     watch_entities?: WatchEntity[]
 *     roles?: string[]               // hint folded into LLM extraction prompt
 *     keywords?: string[]            // hint folded into LLM extraction prompt
 *     search_type?: 'auto' | 'keyword' | 'neural'  // default 'auto'
 *   }
 */

import { createHash } from 'node:crypto';
import { callTool, entityIdsOfType } from '@agent-crm/tools';
import { chatComplete } from '@agent-crm/primitives';
import type { Connector, ConnectorContext, ConnectorResult } from '../types.js';
import { validateCompanyName, getWatchedAccounts, matchAlias, buildAliases } from '../utils.js';

const EXTRACT_MODEL = 'deepseek/deepseek-v4-flash:free';
const EXA_API = 'https://api.exa.ai/search';

interface WatchEntity { entity_id: string; name: string; aliases?: string[] }

interface ExaResult {
  id: string;
  title: string | null;
  url: string;
  publishedDate?: string;
  author?: string;
  text?: string;
  score?: number;
}

export { exaMeta as meta } from '../registry_meta.js';

function normalizeDomain(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch { return null; }
}

const exa: Connector = async (ctx: ConnectorContext): Promise<ConnectorResult> => {
  const result: ConnectorResult = { signals_created: 0, entities_created: 0, skipped: 0, errors: [] };
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) { result.errors.push('EXA_API_KEY env is not set'); return result; }

  const query = (ctx.config.query as string)?.trim();
  if (!query) { result.errors.push('config.query is required'); return result; }

  let watch = ((ctx.config.watch_entities as WatchEntity[]) ?? []);
  const intentRaw = (ctx.config.intent as string) ?? 'auto';
  const intent: 'watch' | 'discover' = intentRaw === 'discover' ? 'discover'
    : intentRaw === 'watch' ? 'watch'
    : (watch.length > 0 ? 'watch' : 'discover');

  // Watch-mode default: load every active (non-dropped) workspace account when
  // the caller didn't pass an explicit list. Same pattern as web.ts and hn.ts.
  if (intent === 'watch' && !watch.length) {
    try {
      watch = await getWatchedAccounts(ctx.supabase, ctx.workspace_id);
    } catch (e) {
      result.errors.push(`load active accounts failed: ${e instanceof Error ? e.message : String(e)}`);
      return result;
    }
    if (!watch.length) return result; // no accounts to watch — no-op
  }

  const include_domains = (ctx.config.include_domains as string[] ?? []).filter(Boolean);
  const exclude_domains = (ctx.config.exclude_domains as string[] ?? []).filter(Boolean);
  const num_results = (ctx.config.num_results as number) ?? 25;
  const since_hours = (ctx.config.since_hours as number) ?? 168;
  const search_type = ((ctx.config.search_type as string) ?? 'auto') as 'auto' | 'keyword' | 'neural';
  const roles = (ctx.config.roles as string[] ?? []).filter(Boolean);
  const keywords = (ctx.config.keywords as string[] ?? []).filter(Boolean);

  // Workspace-configured blocklist for media publications / never-target brands.
  // Defaults to empty so the same code runs vertical-neutral; customers in
  // different verticals provide their own list via workspaces.policy.
  const policyRow = await ctx.supabase.from('workspaces').select('policy').eq('id', ctx.workspace_id).maybeSingle();
  const publicationBlocklist = (((policyRow.data?.policy as Record<string, unknown> | null)?.publication_blocklist) as string[] | undefined ?? []).filter(Boolean);

  const startPublishedDate = new Date(Date.now() - since_hours * 3600 * 1000).toISOString();

  // Append role/keyword filters to the query if present (Exa weights query terms heavily).
  const effectiveQuery = [
    query,
    ...(roles.length ? [`roles: ${roles.join(', ')}`] : []),
    ...(keywords.length ? [keywords.join(' ')] : []),
  ].join(' ').slice(0, 500);

  let exaResults: ExaResult[];
  try {
    const reqBody: Record<string, unknown> = {
      query: effectiveQuery,
      type: search_type,
      numResults: Math.min(num_results, 100),
      contents: { text: { maxCharacters: 1500 } },
      startPublishedDate,
    };
    if (include_domains.length) reqBody.includeDomains = include_domains;
    if (exclude_domains.length) reqBody.excludeDomains = exclude_domains;

    const r = await fetch(EXA_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify(reqBody),
    });
    if (!r.ok) { result.errors.push(`Exa ${r.status}: ${(await r.text()).slice(0, 300)}`); return result; }
    const j = await r.json() as { results: ExaResult[] };
    exaResults = j.results ?? [];
  } catch (e) {
    result.errors.push(`Exa fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }

  // Dedup against signals seen in window (by Exa's result id).
  const cutoffMs = Date.now() - since_hours * 3600 * 1000;
  const seen = await ctx.supabase
    .from('signals')
    .select('structured_tags')
    .eq('workspace_id', ctx.workspace_id)
    .eq('type', 'exa_result')
    .gte('observed_at', new Date(cutoffMs).toISOString());
  const seenIds = new Set<string>();
  for (const s of seen.data ?? []) {
    const id = (s.structured_tags as { exa_id?: string } | null)?.exa_id;
    if (id) seenIds.add(id);
  }

  const fresh = exaResults.filter((r) => !seenIds.has(r.id));
  result.skipped += exaResults.length - fresh.length;
  if (fresh.length === 0) return result;

  // For discover mode, batch-extract company_name per result via one LLM call.
  let companyByExaId = new Map<string, { name: string; domain: string | null }>();
  if (intent === 'discover') {
    try {
      const detailed = await batchExtractCompaniesDetailed(fresh, { roles, keywords, publicationBlocklist }, ((ctx.config.model as string) ?? EXTRACT_MODEL));
      companyByExaId = detailed.companies;
      if (detailed.silently_dropped.length) {
        result.errors.push(`LLM omitted ${detailed.silently_dropped.length} ids from response (spec violation)`);
      }
    } catch (e) {
      result.errors.push(`company extraction failed: ${e instanceof Error ? e.message : String(e)}`);
      return result;
    }
  }

  // Pre-fetch existing entities for dedup.
  let entitiesByDomain = new Map<string, { id: string; name: string }>();
  let entitiesByName = new Map<string, { id: string; name: string }>();
  if (intent === 'discover') {
    const acctIds = await entityIdsOfType(ctx.supabase, ctx.workspace_id, 'account');
    const ents = acctIds.length === 0
      ? { data: [] as Array<{ id: string; name: string; attributes: unknown }> }
      : await ctx.supabase
          .from('entities').select('id, name, attributes')
          .in('id', acctIds);
    for (const e of ents.data ?? []) {
      const d = (e.attributes as { domain?: string } | null)?.domain ?? null;
      if (d) entitiesByDomain.set(d.toLowerCase(), { id: e.id as string, name: e.name as string });
      entitiesByName.set((e.name as string).toLowerCase(), { id: e.id as string, name: e.name as string });
    }
  }

  const sourceActor = { workspace_id: ctx.workspace_id, actor_kind: 'agent' as const, actor_id: `source:exa:${ctx.source_id.slice(0, 8)}` };

  for (const er of fresh) {
    let entity_id: string;
    let matched_alias: string;

    if (intent === 'watch') {
      const haystack = `${er.title ?? ''} ${er.url} ${er.text ?? ''} ${er.author ?? ''}`;
      let pick: { entity_id: string; name: string; alias: string } | null = null;
      for (const w of watch) {
        const aliases = ('aliases' in w && Array.isArray((w as any).aliases))
          ? (w as { aliases: string[] }).aliases
          : buildAliases(w.name, null);
        const aliasHit = matchAlias(haystack, aliases);
        if (aliasHit) { pick = { entity_id: w.entity_id, name: w.name, alias: aliasHit }; break; }
      }
      if (!pick) { result.skipped++; continue; }
      entity_id = pick.entity_id;
      matched_alias = pick.alias;
    } else {
      const company = companyByExaId.get(er.id);
      if (!company || !company.name) { result.skipped++; continue; }
      const domain = company.domain ?? normalizeDomain(er.url);

      let existing = domain ? entitiesByDomain.get(domain) : undefined;
      if (!existing) existing = entitiesByName.get(company.name.toLowerCase());

      if (existing) {
        entity_id = existing.id;
        matched_alias = existing.name;
      } else {
        const created = await callTool(ctx.supabase, sourceActor, 'create_account', {
          name: company.name,
          attributes: {
            domain: domain ?? `${company.name.toLowerCase().replace(/[^a-z0-9]+/g, '')}.example`,
            discovered_via: 'exa',
            discovered_at: new Date().toISOString(),
            search_query: query,
          },
        });
        if (!created.ok) { result.errors.push(`create_account failed for ${company.name}: ${created.error}`); continue; }
        entity_id = created.target_id;
        matched_alias = company.name;
        result.entities_created++;
        if (domain) entitiesByDomain.set(domain, { id: entity_id, name: company.name });
        entitiesByName.set(company.name.toLowerCase(), { id: entity_id, name: company.name });
      }
    }

    const body = `${er.title ?? '(no title)'} — ${(er.text ?? '').slice(0, 400)}  (${er.url})`;
    const r = await callTool(ctx.supabase, sourceActor, 'create_signal', {
      entity_id,
      type: 'exa_result',
      magnitude: 0.6,
      body_for_embedding: body,
      structured_tags: {
        signal_source: 'exa',
        source_id: ctx.source_id,
        exa_id: er.id,
        item_url: er.url,
        author: er.author,
        published_at: er.publishedDate ?? null,
        score: er.score,
        intent,
        query,
        roles: roles.length ? roles : undefined,
        keywords: keywords.length ? keywords : undefined,
        matched_alias,
      },
    });
    if (r.ok) result.signals_created++;
    else result.errors.push(`create_signal failed: ${r.error}`);
  }

  return result;
};

export async function batchExtractCompanies(
  results: ExaResult[],
  hints: { roles: string[]; keywords: string[]; publicationBlocklist?: string[] },
  model: string,
): Promise<Map<string, { name: string; domain: string | null }>> {
  const { companies } = await batchExtractCompaniesDetailed(results, hints, model);
  return companies;
}

/** Detailed variant: returns the companies map plus the rejection notes and any
 *  silently dropped ids (LLM violated the "every id must appear" rule). Used by
 *  the connector to log spec violations and by debug scripts. */
export async function batchExtractCompaniesDetailed(
  results: ExaResult[],
  hints: { roles: string[]; keywords: string[]; publicationBlocklist?: string[] },
  model: string,
): Promise<{
  companies: Map<string, { name: string; domain: string | null }>;
  rejected: Map<string, string>;
  silently_dropped: string[];
}> {
  const empty = { companies: new Map<string, { name: string; domain: string | null }>(), rejected: new Map<string, string>(), silently_dropped: [] };
  if (results.length === 0) return empty;

  const filterClauses: string[] = [];
  if (hints.roles.length) filterClauses.push(`Strongly prefer items where the role/title matches one of: ${hints.roles.join(' | ')}.`);
  if (hints.keywords.length) filterClauses.push(`Strongly prefer items matching one of: ${hints.keywords.join(' | ')}.`);
  const filterBlock = filterClauses.length ? `\n${filterClauses.join('\n')}\n` : '';

  // Workspace-specific brand names to always reject. Comes from
  // workspaces.policy.publication_blocklist. Empty by default.
  const blocklistLine = (hints.publicationBlocklist?.length)
    ? `\nThe following names are publications/content sites this workspace has marked as never-targets — REJECT them with reason "media_publication": ${hints.publicationBlocklist.join(', ')}.\n`
    : '';

  const sysPrompt = `For each web page, identify the COMPANY most worth tracking as a sales target — a real operating company a seller would want in their pipeline.
- News/funding: the subject company (the one that raised, launched, or is featured).
- Job posts: the hiring company.
- Blog or op-ed: the publisher of the post if a real company; otherwise the company the post is about.
- Comparisons or listicles: pick the FIRST 1-2 companies recommended or featured. Do not bail with "too many subjects" - pick the first plausible one.
- Forum / community discussion threads: extract only if a specific company is clearly the subject.${filterBlock}${blocklistLine}

NEVER return:
- A user handle, slug, or lowercase one-word string.
- A media publication, news outlet, blog network, content site, or industry-trade publication — even if it is a real company. Publishers write ABOUT companies; they are not themselves the target.
- A generic noun or pronoun ("the team", "the company", "our customers").
- A product feature, marketing phrase, or slide-deck buzzword. If the candidate name reads like a tagline rather than a brand, reject as buzzword_phrase.
- A person's name.
- An invented or hallucinated company. If you cannot tie the name to text in the page, reject.
- An article title or descriptive headline ("Best X for Y", "How to Z", "Top N tools"). These are content, not companies.

CAPITALIZATION RULE: a real company name begins with a capital letter and is not a generic phrase. If you would return it in all-lowercase rather than title-case, reject as not_a_company.

EVERY input id MUST appear in exactly one of "companies" or "rejected". Do not omit any.

Return JSON:
{
  "companies": [{"id": "<exa id>", "name": "<company name>", "domain": "<root domain or empty>"}],
  "rejected":  [{"id": "<exa id>", "reason": "<reason_code>"}]
}

reason_code is one of:
"topic_only_no_subject" | "forum_discussion_no_company" | "doesnt_match_filter" | "non_english" | "paywalled_or_thin_content" | "personal_blog_no_company" | "ambiguous_multi_subject" | "user_handle_not_company" | "person_not_company" | "media_publication" | "not_a_company" | "buzzword_phrase" | "article_title"`;

  const userPayload = JSON.stringify(results.map((r) => ({
    id: r.id,
    title: r.title,
    url: r.url,
    author: r.author,
    text: (r.text ?? '').slice(0, 800),
  })));

  const llm = await chatComplete({
    model,
    max_tokens: 2500,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: sysPrompt },
      { role: 'user', content: `Classify each result and return JSON in the format above:\n\n${userPayload}` },
    ],
  });
  const parsed = JSON.parse(llm.text) as {
    companies?: Array<{ id: string; name: string; domain?: string }>;
    rejected?: Array<{ id: string; reason: string }>;
  };
  const companies = new Map<string, { name: string; domain: string | null }>();
  const rejected = new Map<string, string>();
  for (const c of parsed.companies ?? []) {
    if (!c.id || !c.name) continue;
    const name = c.name.trim();
    const domain = c.domain?.trim() || null;
    const reject = validateCompanyName(name, domain, hints.publicationBlocklist ?? []);
    if (reject) { rejected.set(c.id, reject); continue; }
    companies.set(c.id, { name, domain });
  }
  for (const r of parsed.rejected ?? []) {
    if (r.id && r.reason) rejected.set(r.id, r.reason);
  }
  const seen = new Set<string>([...companies.keys(), ...rejected.keys()]);
  const silently_dropped = results.map((r) => r.id).filter((id) => !seen.has(id));
  return { companies, rejected, silently_dropped };
}

export default exa;
