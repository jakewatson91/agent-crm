/**
 * Generic web/RSS connector. Two intents:
 *
 *   1. WATCH (default when watch_entities is non-empty)
 *      Items are filtered to those mentioning a known entity. Signal goes on that entity.
 *      Use case: a newsletter or feed for posts mentioning entities you already track.
 *
 *   2. DISCOVER (default when watch_entities is empty)
 *      Each extracted item carries a company_name. The connector dedupes-or-creates
 *      an entity per company name, then emits a signal on that entity.
 *      Use case: a hiring board scanned for roles — every matching post creates or
 *      attaches to an entity for the company that posted it.
 *
 * Both modes accept any extra criteria (roles, keywords, locations, etc.) as free-form
 * fields in config. The connector folds them into the LLM extraction prompt as filters.
 * No fixed schema beyond url + mode.
 *
 * Cost note: HTML extraction runs one model call per fetch (~$0.001–0.01).
 */

import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { callTool, chatCompleteForWorkspace, compress, entityIdsOfType, fetchSeenSignalTags, getPolicy, resolveBehaviorModel, resolvePublishedDate } from '@agent-crm/tools';
import type { Connector, ConnectorContext, ConnectorResult } from '../types.ts';
import { validateCompanyName, getWatchedAccounts, matchAlias, buildAliases } from '../utils.ts';

const EXTRACT_MODEL = 'deepseek-v4-flash';

interface WatchEntity { entity_id: string; name: string; aliases?: string[] }
export interface ExtractedItem {
  title: string;
  url: string;
  body: string;
  published_at?: string;
  company_name?: string;       // discover mode: which company posted this
  company_domain?: string;     // discover mode: optional, used for entity dedup
  guid: string;
}

export { webMeta as meta } from '../registry_meta.ts';

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

export function parseRssOrAtom(xml: string, sourceUrl: string): ExtractedItem[] {
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
  supabase: SupabaseClient,
  workspace_id: string,
  html: string,
  sourceUrl: string,
  opts: { hint: string; intent: 'watch' | 'discover'; roles: string[]; keywords: string[] },
  model: string,
): Promise<ExtractedItem[]> {
  // compress() runs HTML→markdown, URL collapse to [ref:N] markers, and
  // whitespace dedup. Typically cuts char count 60–80% on real pages, which
  // translates directly into fewer tokens through the extractor model.
  // Refs are surfaced in the system prompt so the LLM can still resolve URLs.
  const compressed = await compress(html, { max_chars: 30000 });
  const truncated = compressed.text;
  const refsBlock = compressed.refs.length
    ? `\n\nURL refs (referenced as [ref:N] in body):\n${compressed.refs.map((r) => `[ref:${r.id}] ${r.url}`).join('\n')}`
    : '';

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

  const llm = await chatCompleteForWorkspace(supabase, workspace_id, {
    model,
    max_tokens: 2000,
    // Copying items out of HTML into a fixed shape. Up to 30 of them, so
    // thinking scales with the page and buys nothing: the title is the title.
    thinking: 'disabled',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: sysPrompt },
      // OpenAI requires the literal word "json" somewhere in the messages when using
      // response_format=json_object. The system prompt already says "Output strictly:" with
      // a JSON shape, but OpenAI's check is text-based and looks for the literal word.
      { role: 'user', content: `Extract items from this page and return JSON in the format described above. The body has been converted to markdown and long URLs replaced with [ref:N] markers — substitute the real URL from the refs table when populating "url".\n\n${truncated}${refsBlock}` },
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

/** Reject candidate company names that match user-handle shape: lowercase, no
 *  spaces, possibly digits/_/-, no TLD. Catches the Indie Hackers username-as-
 *  company bug ("manishbhusal", "jakew_91") without dropping legit lowercase
 *  one-word brands ("stripe", "ramp") which usually appear capitalized in
 *  article text and are caught by the LLM disambiguation step regardless. */
function looksLikeHandle(name: string): boolean {
  const s = name.trim();
  if (!s) return true;
  // Allow if it has uppercase chars, spaces, or a dot (suggests a domain or proper noun)
  if (/[A-Z\s.]/.test(s)) return false;
  // Single short word (≤4 chars) might be a real lowercased brand reference; let LLM decide
  if (s.length <= 4) return false;
  // Long lowercase token, possibly with digits/underscore/hyphen → handle-shaped
  return /^[a-z][a-z0-9_-]+$/.test(s);
}

/** Items per LLM call. Matches EXTRACT_BATCH in connectors/exa.ts, which carries
 *  the reasoning: an id-echoing classifier's reply grows with the input, so the
 *  input is what has to be bounded. */
const IDENTIFY_BATCH = 10;

/** RSS feeds don't tell us which company each post is about. In discover mode we
 *  ask the LLM in batches. Returns the same items array with company_name
 *  and company_domain populated when extractable. Captures rejection reasons for
 *  the audit trail. */
export async function enrichItemsWithCompanyName(
  supabase: SupabaseClient,
  workspace_id: string,
  items: ExtractedItem[],
  opts: { hint: string; roles: string[]; keywords: string[] },
  model: string,
): Promise<{ items: ExtractedItem[]; notes: Map<string, string>; silently_dropped: number }> {
  if (items.length === 0) return { items, notes: new Map<string, string>(), silently_dropped: 0 };
  // Same ceiling problem the Exa classifier has, from the same shape: the model
  // echoes every guid back, and extractWithLLM upstream allows 30 items against
  // a max_tokens of 2500. A reply that does not fit is cut mid-object, and the
  // guids the model never reached are indistinguishable here from guids it chose
  // to skip, so they are filed as `silently_dropped_by_llm` and the items lose
  // their company. See EXTRACT_BATCH in connectors/exa.ts.
  if (items.length > IDENTIFY_BATCH) {
    const chunks: ExtractedItem[][] = [];
    for (let i = 0; i < items.length; i += IDENTIFY_BATCH) chunks.push(items.slice(i, i + IDENTIFY_BATCH));
    // A failed batch gives up only its own items, rather than the caller
    // abandoning every item on the feed.
    const parts = await Promise.all(chunks.map((c) =>
      enrichItemsWithCompanyName(supabase, workspace_id, c, opts, model)
        .catch(() => ({ items: c.map((it) => ({ ...it, company_name: undefined })), notes: new Map<string, string>(), silently_dropped: c.length })),
    ));
    const notes = new Map<string, string>();
    let silently_dropped = 0;
    const out: ExtractedItem[] = [];
    for (const p of parts) {
      out.push(...p.items);
      for (const [k, v] of p.notes) notes.set(k, v);
      silently_dropped += p.silently_dropped;
    }
    return { items: out, notes, silently_dropped };
  }

  const filterClauses: string[] = [];
  if (opts.roles.length) filterClauses.push(`Only include items whose role/title matches: ${opts.roles.join(' | ')}.`);
  if (opts.keywords.length) filterClauses.push(`Only include items matching: ${opts.keywords.join(' | ')}.`);
  const filterBlock = filterClauses.length ? `\nFilters: ${filterClauses.join(' ')}\n` : '';

  const sysPrompt = `Each item below is an RSS entry: a title, url, and short body. Identify the COMPANY most worth tracking:
- Funding/news: the subject company (the one that raised, launched, or is featured).
- Product/launch news: the company that shipped.
- Hiring posts: the hiring company.
- Comparisons or listicles ("best X", "top N tools"): pick the FIRST 1-2 companies recommended or featured. Do not bail with "multi-subject ambiguous" - pick the first plausible one.
- Blog or op-ed: the publisher of the post if a real company; otherwise the company the post is about.
- Podcast / community / event posts (no specific company subject): mark rejected.${filterBlock}

NEVER return:
- A user handle as a company name (single lowercase word like "manishbhusal" or "jakeawatson"). Posts authored by a user with no company subject go in "rejected".
- A generic noun ("the company", "the team", "the startup") as a company_name.
- A person's name as a company. People are not companies.
- An invented company.

EVERY input guid MUST appear in exactly one of the two arrays. Do not omit any.

Return JSON:
{
  "companies": [{"guid": "<from input>", "company_name": "<name>", "company_domain": "<root domain or empty>"}],
  "rejected":  [{"guid": "<from input>", "reason": "<reason_code>"}]
}

reason_code is one of:
"topic_only_no_subject" | "podcast_or_community" | "user_handle_not_company" | "person_not_company" | "generic_noun" | "doesnt_match_filter" | "non_english" | "ambiguous_multi_subject" | "paywalled_or_thin_content"`;

  const userPayload = JSON.stringify(items.map((it) => ({
    guid: it.guid,
    title: it.title,
    url: it.url,
    body: (it.body ?? '').slice(0, 400),
  })));

  const llm = await chatCompleteForWorkspace(supabase, workspace_id, {
    model,
    max_tokens: 2500,
    // One company name per item. Fixed shape, one field each.
    thinking: 'disabled',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: sysPrompt },
      { role: 'user', content: `Identify the company per item and return JSON:\n\n${userPayload}` },
    ],
  });
  const parsed = JSON.parse(llm.text) as {
    companies?: Array<{ guid: string; company_name: string; company_domain?: string }>;
    rejected?: Array<{ guid: string; reason: string }>;
  };
  const byGuid = new Map<string, { company_name: string; company_domain: string | null }>();
  for (const c of parsed.companies ?? []) {
    if (!c.guid || !c.company_name) continue;
    byGuid.set(c.guid, { company_name: c.company_name.trim(), company_domain: c.company_domain?.trim() || null });
  }
  const notes = new Map<string, string>();
  for (const r of parsed.rejected ?? []) {
    if (r.guid && r.reason) notes.set(r.guid, r.reason);
  }
  let silently_dropped = 0;
  const out = items.map((it) => {
    const c = byGuid.get(it.guid);
    if (!c) {
      if (!notes.has(it.guid)) {
        notes.set(it.guid, 'silently_dropped_by_llm');
        silently_dropped++;
      }
      return { ...it, company_name: undefined };
    }
    // Defensive filter: even if LLM said it was a company, reject handle-shape names.
    if (looksLikeHandle(c.company_name)) {
      notes.set(it.guid, `rejected handle-shape name: "${c.company_name}"`);
      return { ...it, company_name: undefined };
    }
    return { ...it, company_name: c.company_name, company_domain: c.company_domain ?? undefined };
  });
  return { items: out, notes, silently_dropped };
}

const web: Connector = async (ctx: ConnectorContext): Promise<ConnectorResult> => {
  const result: ConnectorResult = { signals_created: 0, entities_created: 0, skipped: 0, errors: [] };
  const url = (ctx.config.url as string)?.trim();
  let watch = ((ctx.config.watch_entities as WatchEntity[]) ?? []);
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

  // Watch-mode default: load every active (non-dropped) workspace account when
  // the caller didn't pass an explicit list. Setup-first — connector users
  // don't maintain entity-ID lists by hand. Mirrors HN's behavior.
  if (intent === 'watch' && !watch.length) {
    try {
      watch = await getWatchedAccounts(ctx.supabase, ctx.workspace_id);
    } catch (e) {
      result.errors.push(`load active accounts failed: ${e instanceof Error ? e.message : String(e)}`);
      return result;
    }
    if (!watch.length) return result; // no accounts to watch — no-op
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
  let extractionNotes = new Map<string, string>();
  try {
    // Precedence, most specific first: the model named on this source, then the
    // workspace's choice for extraction, then the code default. Resolved here
    // rather than inside the call so a source that names a model keeps it — the
    // workspace setting is a fallback for sources that name none, not an
    // override of one that does.
    const extractModel = ((ctx.config.model as string)
      ?? resolveBehaviorModel(await getPolicy(ctx.supabase, ctx.workspace_id), 'connector_extract', EXTRACT_MODEL));
    items = isFeed
      ? parseRssOrAtom(body, url)
      : await extractWithLLM(ctx.supabase, ctx.workspace_id, body, url, { hint: extraction_hint, intent, roles, keywords }, extractModel);

    // RSS-derived items don't carry company_name. In discover mode, do a small LLM
    // pass to extract it per item — otherwise every RSS item gets skipped because
    // there's no entity to attach to. One model call covers the whole batch.
    if (isFeed && intent === 'discover' && items.length > 0) {
      try {
        const enriched = await enrichItemsWithCompanyName(ctx.supabase, ctx.workspace_id, items, { hint: extraction_hint, roles, keywords }, extractModel);
        items = enriched.items;
        extractionNotes = enriched.notes;
        if (enriched.silently_dropped > 0) {
          result.errors.push(`LLM omitted ${enriched.silently_dropped} guids from response (spec violation)`);
        }
      } catch (e) {
        result.errors.push(`rss company-name extraction failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e) {
    result.errors.push(`${isFeed ? 'rss parse' : 'llm extract'} failed: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }

  // Correct each date against its URL before filtering. A feed's own <pubDate>
  // and an LLM reading a page are both capable of handing back the date the item
  // was seen rather than the date it was written, and either one makes an old
  // post look current. Where the URL carries the publication date it wins. Same
  // correction the search path applies; see published_date.ts.
  items = items.map((it) => {
    const resolved = resolvePublishedDate(it.url, it.published_at);
    return resolved.publishedDate === it.published_at
      ? it
      : { ...it, published_at: resolved.publishedDate ?? undefined };
  });

  // Filter by recency.
  const cutoffMs = Date.now() - since_hours * 3600 * 1000;
  items = items.filter((it) => {
    if (!it.published_at) return true;
    const t = Date.parse(it.published_at);
    return Number.isFinite(t) ? t >= cutoffMs : true;
  });

  // Dedup against signals seen in the same window.
  const seen = await fetchSeenSignalTags(ctx.supabase, {
    workspace_id: ctx.workspace_id,
    type: 'web_mention',
    sinceISO: new Date(cutoffMs).toISOString(),
  });
  const seenGuids = new Set<string>();
  for (const s of seen) {
    const g = (s.structured_tags as { guid?: string } | null)?.guid;
    if (g) seenGuids.add(g);
  }

  // For discover mode: pre-fetch existing entities for dedup by domain or name.
  let entitiesByDomain = new Map<string, { id: string; name: string }>();
  let entitiesByName = new Map<string, { id: string; name: string; domain: string | null }>();
  if (intent === 'discover') {
    const acctIds = await entityIdsOfType(ctx.supabase, ctx.workspace_id, 'account');
    const ents = acctIds.length === 0
      ? { data: [] as Array<{ id: string; name: string; attributes: unknown }> }
      : await ctx.supabase
          .from('entities')
          .select('id, name, attributes')
          .in('id', acctIds);
    for (const e of ents.data ?? []) {
      const d = (e.attributes as { domain?: string } | null)?.domain ?? null;
      if (d) entitiesByDomain.set(d.toLowerCase(), { id: e.id as string, name: e.name as string });
      entitiesByName.set((e.name as string).toLowerCase(), { id: e.id as string, name: e.name as string, domain: d });
    }
  }

  const sourceActor = { workspace_id: ctx.workspace_id, actor_kind: 'agent' as const, actor_id: `source:web:${ctx.source_id.slice(0, 8)}` };

  const policyRow = await ctx.supabase.from('workspaces').select('policy').eq('id', ctx.workspace_id).maybeSingle();
  const publicationBlocklist = (((policyRow.data?.policy as Record<string, unknown> | null)?.publication_blocklist) as string[] | undefined ?? []).filter(Boolean);

  for (const it of items) {
    if (seenGuids.has(it.guid)) { result.skipped++; continue; }

    let entity_id: string;
    let matched_alias: string;

    if (intent === 'watch') {
      const haystack = `${it.title} ${it.url} ${it.body}`;
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
      // discover: dedup-or-create entity per company_name
      const companyName = it.company_name?.trim();
      if (!companyName) { result.skipped++; continue; }
      // Defensive: reject any company name that slipped through to discover phase
      // looking like a user handle (shouldn't happen post-enrichItemsWithCompanyName,
      // but extracted-with-LLM HTML mode doesn't go through that filter).
      if (looksLikeHandle(companyName)) {
        extractionNotes.set(it.guid, `rejected handle-shape name: "${companyName}"`);
        result.skipped++; continue;
      }
      const companyDomain = normalizeDomain(it.company_domain) ?? normalizeDomain(it.url);

      let existing = companyDomain ? entitiesByDomain.get(companyDomain) : undefined;
      if (!existing) existing = entitiesByName.get(companyName.toLowerCase());

      if (existing) {
        entity_id = existing.id;
        matched_alias = existing.name;
      } else {
        const reject = validateCompanyName(companyName, companyDomain, publicationBlocklist);
        if (reject) { result.skipped++; continue; }
        const created = await callTool(ctx.supabase, sourceActor, 'create_account', {
          name: companyName,
          attributes: {
            domain: companyDomain ?? `${companyName.toLowerCase().replace(/[^a-z0-9]+/g, '')}.example`,
            _discovered_via: 'web',
            discovered_at: new Date().toISOString(),
            _source_url: url,
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

    const note = extractionNotes.get(it.guid);
    const r = await callTool(ctx.supabase, sourceActor, 'create_signal', {
      entity_id,
      type: 'web_mention',
      magnitude: 0.55,
      body_for_embedding: `${it.title} — ${it.body}  (${it.url})`,
      structured_tags: {
        signal_source: 'web',
        source_id: ctx.source_id,
        source_url: url,
        intent,
        fetch_mode: isFeed ? 'rss' : 'html',
        item_url: it.url,
        guid: it.guid,
        published_at: it.published_at ?? null,
        matched_alias,
        roles: roles.length ? roles : undefined,
        keywords: keywords.length ? keywords : undefined,
        extraction_note: note,
      },
    });
    if (r.ok) result.signals_created++;
    else result.errors.push(`create_signal failed: ${r.error}`);
  }

  return result;
};

export default web;
