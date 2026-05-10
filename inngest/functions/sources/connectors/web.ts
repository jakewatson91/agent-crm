/**
 * Generic web/RSS connector. Two intents:
 *
 *   1. WATCH (default when watch_entities is non-empty)
 *      Items are filtered to those mentioning a known entity. Signal goes on that entity.
 *      Use case: "watch the Lenny's Newsletter for posts mentioning {Acme, Beta}".
 *
 *   2. DISCOVER (default when watch_entities is empty)
 *      Each extracted item carries a company_name. The connector dedupes-or-creates
 *      an entity per company name, then emits a signal on that entity.
 *      Use case: "watch jobs.yc.com for GTM hires" — every matching job post creates
 *      or attaches to an entity for the company that posted it.
 *
 * Both modes accept any extra criteria (roles, keywords, locations, etc.) as free-form
 * fields in config. The connector folds them into the LLM extraction prompt as filters.
 * No fixed schema beyond url + mode.
 *
 * Cost note: HTML extraction runs one model call per fetch (~$0.001–0.01).
 */

import { createHash } from 'node:crypto';
import { callTool } from '@agent-crm/tools';
import { chatComplete } from '@agent-crm/primitives';
import type { Connector, ConnectorContext, ConnectorResult, ConnectorMeta } from '../types.js';

const EXTRACT_MODEL = 'gpt-4o-mini';

interface WatchEntity { entity_id: string; name: string; aliases?: string[] }
interface ExtractedItem {
  title: string;
  url: string;
  body: string;
  published_at?: string;
  company_name?: string;       // discover mode: which company posted this
  company_domain?: string;     // discover mode: optional, used for entity dedup
  guid: string;
}

export const meta: ConnectorMeta = {
  type: 'web',
  label: 'Web / RSS scrape',
  description: 'Fetch any URL. Auto-detects RSS; falls back to HTML + LLM extraction. Watch mode filters to known entities; discover mode creates entities per company found. Best for static URLs and RSS feeds.',
  category: 'tool',
  emits_signal_source: 'web',
  schedule_cron: '0 */6 * * *',
  config_schema: {
    fields: [
      {
        name: 'url',
        label: 'URL to fetch',
        kind: 'text',
        required: true,
        help: 'e.g. https://acme.com/blog, https://www.ycombinator.com/jobs, https://substack.com/feed.xml',
      },
      {
        name: 'intent',
        label: 'Intent',
        kind: 'text',
        default: 'auto',
        help: '"watch" (filter to known entities), "discover" (create entities per item), "auto" (watch if watch_entities populated, else discover).',
      },
      {
        name: 'watch_entities',
        label: 'Entities to watch (watch mode only)',
        kind: 'entity_picker_multi',
        help: 'Leave empty for discover mode. Required for watch mode.',
      },
      {
        name: 'roles',
        label: 'Role keywords (free text)',
        kind: 'string_array',
        help: 'Comma-separated. Folded into the extraction prompt as a filter. Example: "Founding GTM, GTM Engineer, Growth, Automation Engineer".',
      },
      {
        name: 'keywords',
        label: 'Other keywords (free text)',
        kind: 'string_array',
        help: 'Comma-separated. Same as roles but for non-role criteria. Example: "remote, equity > 1%, San Francisco".',
      },
      {
        name: 'fetch_mode',
        label: 'Fetch mode',
        kind: 'text',
        default: 'auto',
        help: '"auto" (detect RSS vs HTML), "rss" (force feed parsing), "html" (force LLM extraction).',
      },
      {
        name: 'since_hours',
        label: 'Look back (hours)',
        kind: 'number',
        default: 168,
        help: 'Skip items older than this. Default 168 = 1 week.',
      },
      {
        name: 'extraction_prompt',
        label: 'Extraction hint (HTML mode only)',
        kind: 'textarea',
        help: 'Optional. e.g. "Find job listings. Each has a role, company, location, posted date."',
      },
    ],
  },
};

function looksLikeXmlFeed(headers: Headers, body: string): boolean {
  const ct = headers.get('content-type') ?? '';
  if (ct.includes('xml') || ct.includes('rss') || ct.includes('atom')) return true;
  const head = body.slice(0, 500).toLowerCase();
  return head.includes('<?xml') && (head.includes('<rss') || head.includes('<feed'));
}

function unescape(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .trim();
}

function parseRssOrAtom(xml: string, sourceUrl: string): ExtractedItem[] {
  const items: ExtractedItem[] = [];
  const isAtom = /<feed[\s>]/i.test(xml);
  const itemBlocks = isAtom
    ? xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? []
    : xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];

  for (const block of itemBlocks) {
    const title = unescape((block.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]) ?? '');
    let link = '';
    if (isAtom) {
      const m = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
      link = m?.[1] ?? '';
    } else {
      link = unescape((block.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1]) ?? '');
    }
    const body = unescape(
      (block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i)?.[1])
      ?? (block.match(/<description[^>]*>([\s\S]*?)<\/description>/i)?.[1])
      ?? (block.match(/<content[^>]*>([\s\S]*?)<\/content>/i)?.[1])
      ?? '',
    );
    const date = unescape(
      (block.match(/<published[^>]*>([\s\S]*?)<\/published>/i)?.[1])
      ?? (block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i)?.[1])
      ?? (block.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i)?.[1])
      ?? '',
    );
    const guid = unescape(
      (block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i)?.[1])
      ?? (block.match(/<id[^>]*>([\s\S]*?)<\/id>/i)?.[1])
      ?? link
      ?? '',
    );
    if (!title && !body) continue;
    items.push({
      title: title || '(no title)',
      url: link || sourceUrl,
      body: body.replace(/<[^>]+>/g, '').slice(0, 800),
      published_at: date || undefined,
      guid: guid || createHash('sha256').update(`${title}|${link}|${date}`).digest('hex').slice(0, 16),
    });
  }
  return items;
}

async function extractWithLLM(
  html: string,
  sourceUrl: string,
  opts: { hint: string; intent: 'watch' | 'discover'; roles: string[]; keywords: string[] },
  model: string,
): Promise<ExtractedItem[]> {
  const stripped = html
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const truncated = stripped.slice(0, 30000);

  const filterClauses: string[] = [];
  if (opts.roles.length) filterClauses.push(`ROLE FILTER (case-insensitive substring match): only include items whose role/title matches one of: ${opts.roles.join(' | ')}`);
  if (opts.keywords.length) filterClauses.push(`KEYWORD FILTER: only include items matching one of: ${opts.keywords.join(' | ')}`);
  const filterBlock = filterClauses.length ? `\n${filterClauses.join('\n')}\n` : '';

  const itemFields = opts.intent === 'discover'
    ? `{"title":"<text>","url":"<absolute url>","body":"<short summary, max 200 chars>","published_at":"<ISO date or empty>","company_name":"<the company that posted this item>","company_domain":"<root domain of the company website if known, else empty>"}`
    : `{"title":"<text>","url":"<absolute url>","body":"<short summary, max 200 chars>","published_at":"<ISO date or empty>"}`;

  const intentNote = opts.intent === 'discover'
    ? `This is DISCOVER mode: each item should identify the company that posted it. company_name is required; company_domain helps with entity dedup.`
    : `This is WATCH mode: items will be filtered against a list of known companies after extraction.`;

  const sysPrompt = `Extract item-shaped content from the HTML (blog posts, news entries, case studies, job listings, releases — whatever fits the user's intent).
${opts.hint ? `User hint: ${opts.hint}\n` : ''}${intentNote}${filterBlock}
Output strictly: {"items":[${itemFields}]}.
Resolve relative URLs against ${sourceUrl}. Skip nav/footer/cookie banners. Max 30 items.`;

  const llm = await chatComplete({
    model,
    max_tokens: 2000,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: sysPrompt },
      // OpenAI requires the literal word "json" somewhere in the messages when using
      // response_format=json_object. The system prompt already says "Output strictly:" with
      // a JSON shape, but OpenAI's check is text-based and looks for the literal word.
      { role: 'user', content: `Extract items from this HTML and return JSON in the format described above:\n\n${truncated}` },
    ],
  });
  const parsed = JSON.parse(llm.text) as { items: Array<{ title: string; url: string; body: string; published_at?: string; company_name?: string; company_domain?: string }> };
  return (parsed.items ?? []).map((it) => ({
    title: it.title || '(no title)',
    url: it.url || sourceUrl,
    body: (it.body ?? '').slice(0, 800),
    published_at: it.published_at,
    company_name: it.company_name?.trim() || undefined,
    company_domain: it.company_domain?.trim() || undefined,
    guid: createHash('sha256').update(`${it.title}|${it.url}|${it.published_at ?? ''}`).digest('hex').slice(0, 16),
  }));
}

function normalizeDomain(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch { return null; }
}

/** RSS feeds (TechCrunch, Substacks, etc.) don't tell us which company each post is
 *  about. In discover mode we ask the LLM in one batched call. Returns the same
 *  items array with company_name and company_domain populated when extractable. */
async function enrichItemsWithCompanyName(
  items: ExtractedItem[],
  opts: { hint: string; roles: string[]; keywords: string[] },
  model: string,
): Promise<ExtractedItem[]> {
  const filterClauses: string[] = [];
  if (opts.roles.length) filterClauses.push(`Only include items whose role/title matches: ${opts.roles.join(' | ')}.`);
  if (opts.keywords.length) filterClauses.push(`Only include items matching: ${opts.keywords.join(' | ')}.`);
  const filterBlock = filterClauses.length ? `\nFilters: ${filterClauses.join(' ')}\n` : '';

  const sysPrompt = `Each item below is an RSS entry: a title, url, and short body. Identify the COMPANY each item is about (the subject — for funding news, the company that raised; for product news, the company that shipped; for hiring posts, the hiring company; for blog posts, sometimes there is no specific company and you should omit that item).${filterBlock}

Return JSON: {"companies": [{"guid": "<exa-style guid from input>", "company_name": "<name>", "company_domain": "<root domain or empty>"}]}.

Don't invent companies. Omit items where there's no clear company subject. Don't return entries for items that fail the filter above.`;

  const userPayload = JSON.stringify(items.map((it) => ({
    guid: it.guid,
    title: it.title,
    url: it.url,
    body: (it.body ?? '').slice(0, 400),
  })));

  const llm = await chatComplete({
    model,
    max_tokens: 2000,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: sysPrompt },
      { role: 'user', content: `Identify the company per item and return JSON:\n\n${userPayload}` },
    ],
  });
  const parsed = JSON.parse(llm.text) as { companies: Array<{ guid: string; company_name: string; company_domain?: string }> };
  const byGuid = new Map<string, { company_name: string; company_domain: string | null }>();
  for (const c of parsed.companies ?? []) {
    if (!c.guid || !c.company_name) continue;
    byGuid.set(c.guid, { company_name: c.company_name.trim(), company_domain: c.company_domain?.trim() || null });
  }
  return items.map((it) => {
    const c = byGuid.get(it.guid);
    if (!c) return { ...it, company_name: undefined };  // explicitly drop items with no company match
    return { ...it, company_name: c.company_name, company_domain: c.company_domain ?? undefined };
  });
}

const web: Connector = async (ctx: ConnectorContext): Promise<ConnectorResult> => {
  const result: ConnectorResult = { signals_created: 0, entities_created: 0, skipped: 0, errors: [] };
  const url = (ctx.config.url as string)?.trim();
  const watch = ((ctx.config.watch_entities as WatchEntity[]) ?? []);
  const fetchMode = ((ctx.config.fetch_mode as string) ?? 'auto') as 'auto' | 'rss' | 'html';
  const since_hours = (ctx.config.since_hours as number) ?? 168;
  const extraction_hint = (ctx.config.extraction_prompt as string) ?? '';
  const roles = (ctx.config.roles as string[] ?? []).filter(Boolean);
  const keywords = (ctx.config.keywords as string[] ?? []).filter(Boolean);

  // Resolve intent. "auto" picks based on whether watch_entities is populated.
  const intentRaw = (ctx.config.intent as string) ?? 'auto';
  const intent: 'watch' | 'discover' = intentRaw === 'discover' ? 'discover'
    : intentRaw === 'watch' ? 'watch'
    : (watch.length > 0 ? 'watch' : 'discover');

  if (!url) { result.errors.push('config.url is required'); return result; }
  if (intent === 'watch' && !watch.length) {
    result.errors.push('intent=watch requires watch_entities to be non-empty');
    return result;
  }

  let body: string; let headers: Headers;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'agent-crm/web-connector (+https://agent-crm.example)' } });
    if (!r.ok) { result.errors.push(`fetch ${r.status}: ${url}`); return result; }
    headers = r.headers;
    body = await r.text();
  } catch (e) {
    result.errors.push(`fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }

  const isFeed = fetchMode === 'rss' ? true : fetchMode === 'html' ? false : looksLikeXmlFeed(headers, body);

  let items: ExtractedItem[] = [];
  try {
    const extractModel = ((ctx.config.model as string) ?? EXTRACT_MODEL);
    items = isFeed
      ? parseRssOrAtom(body, url)
      : await extractWithLLM(body, url, { hint: extraction_hint, intent, roles, keywords }, extractModel);

    // RSS-derived items don't carry company_name. In discover mode, do a small LLM
    // pass to extract it per item — otherwise every RSS item gets skipped because
    // there's no entity to attach to. One model call covers the whole batch.
    if (isFeed && intent === 'discover' && items.length > 0) {
      try {
        items = await enrichItemsWithCompanyName(items, { hint: extraction_hint, roles, keywords }, extractModel);
      } catch (e) {
        result.errors.push(`rss company-name extraction failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e) {
    result.errors.push(`${isFeed ? 'rss parse' : 'llm extract'} failed: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }

  // Filter by recency.
  const cutoffMs = Date.now() - since_hours * 3600 * 1000;
  items = items.filter((it) => {
    if (!it.published_at) return true;
    const t = Date.parse(it.published_at);
    return Number.isFinite(t) ? t >= cutoffMs : true;
  });

  // Dedup against signals seen in the same window.
  const seen = await ctx.supabase
    .from('signals')
    .select('structured_tags')
    .eq('workspace_id', ctx.workspace_id)
    .eq('type', 'web_mention')
    .gte('observed_at', new Date(cutoffMs).toISOString());
  const seenGuids = new Set<string>();
  for (const s of seen.data ?? []) {
    const g = (s.structured_tags as { guid?: string } | null)?.guid;
    if (g) seenGuids.add(g);
  }

  // For discover mode: pre-fetch existing entities for dedup by domain or name.
  let entitiesByDomain = new Map<string, { id: string; name: string }>();
  let entitiesByName = new Map<string, { id: string; name: string; domain: string | null }>();
  if (intent === 'discover') {
    const ents = await ctx.supabase
      .from('entities')
      .select('id, name, attributes')
      .eq('workspace_id', ctx.workspace_id)
      .eq('kind', 'account');
    for (const e of ents.data ?? []) {
      const d = (e.attributes as { domain?: string } | null)?.domain ?? null;
      if (d) entitiesByDomain.set(d.toLowerCase(), { id: e.id as string, name: e.name as string });
      entitiesByName.set((e.name as string).toLowerCase(), { id: e.id as string, name: e.name as string, domain: d });
    }
  }

  const sourceActor = { workspace_id: ctx.workspace_id, actor_kind: 'agent' as const, actor_id: `source:web:${ctx.source_id.slice(0, 8)}` };

  for (const it of items) {
    if (seenGuids.has(it.guid)) { result.skipped++; continue; }

    let entity_id: string;
    let matched_alias: string;

    if (intent === 'watch') {
      const haystack = `${it.title} ${it.url} ${it.body}`.toLowerCase();
      const matched = watch.find((w) => {
        const candidates = [w.name, ...(w.aliases ?? [])].filter(Boolean).map((s) => s.toLowerCase());
        return candidates.some((c) => haystack.includes(c));
      });
      if (!matched) { result.skipped++; continue; }
      entity_id = matched.entity_id;
      matched_alias = matched.name;
    } else {
      // discover: dedup-or-create entity per company_name
      const companyName = it.company_name?.trim();
      if (!companyName) { result.skipped++; continue; }
      const companyDomain = normalizeDomain(it.company_domain) ?? normalizeDomain(it.url);

      let existing = companyDomain ? entitiesByDomain.get(companyDomain) : undefined;
      if (!existing) existing = entitiesByName.get(companyName.toLowerCase());

      if (existing) {
        entity_id = existing.id;
        matched_alias = existing.name;
      } else {
        const created = await callTool(ctx.supabase, sourceActor, 'create_account', {
          name: companyName,
          attributes: {
            domain: companyDomain ?? `${companyName.toLowerCase().replace(/[^a-z0-9]+/g, '')}.example`,
            discovered_via: 'web',
            discovered_at: new Date().toISOString(),
            source_url: url,
          },
        });
        if (!created.ok) { result.errors.push(`create_account failed for ${companyName}: ${created.error}`); continue; }
        entity_id = created.target_id;
        matched_alias = companyName;
        result.entities_created++;
        if (companyDomain) entitiesByDomain.set(companyDomain, { id: entity_id, name: companyName });
        entitiesByName.set(companyName.toLowerCase(), { id: entity_id, name: companyName, domain: companyDomain });
      }
    }

    const r = await callTool(ctx.supabase, sourceActor, 'create_signal', {
      entity_id,
      type: 'web_mention',
      magnitude: 0.55,
      body_for_embedding: `${it.title} — ${it.body}  (${it.url})`,
      structured_tags: {
        signal_source: 'web',
        source_url: url,
        intent,
        fetch_mode: isFeed ? 'rss' : 'html',
        item_url: it.url,
        guid: it.guid,
        published_at: it.published_at ?? null,
        matched_alias,
        roles: roles.length ? roles : undefined,
        keywords: keywords.length ? keywords : undefined,
      },
    });
    if (r.ok) result.signals_created++;
    else result.errors.push(`create_signal failed: ${r.error}`);
  }

  return result;
};

export default web;
