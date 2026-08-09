/**
 * api_call tool. Build any HTTP request from scratch — URL, method, headers, body, JSON
 * extraction. The escape hatch when no preset fits and Exa isn't appropriate.
 *
 * Each item in the response (selected by items_path) becomes a candidate signal. The
 * connector then either matches against watch_entities (watch mode) or extracts a
 * company name per item via LLM and creates entities (discover mode).
 *
 * Authentication: put any header in the headers JSON. For env-var-backed secrets,
 * use the form `Bearer ${env:OPENAI_API_KEY}` and the connector substitutes from process.env
 * at runtime.
 *
 * Config:
 *   {
 *     url: string,
 *     method?: 'GET'|'POST',          // default GET
 *     headers?: Record<string,string>,// substitutes ${env:NAME} from process.env
 *     body?: string | object,         // optional JSON body for POST
 *     items_path?: string,            // dot path into the response. Default: "" (treat root array as items, or wrap object as single item)
 *     intent?: 'discover'|'watch',
 *     watch_entities?: WatchEntity[],
 *     match_fields?: string[],        // which fields on each item to search for entity name (default: title, name, description)
 *     company_field?: string,         // discover: which field has the company name (e.g. "company.name")
 *     domain_field?: string,          // discover: which field has the domain (e.g. "company.website")
 *     title_field?: string,           // signal body source (default: "title" or "name")
 *     body_field?: string,            // signal body extra (default: "description" or "summary")
 *     id_field?: string,              // dedup key (default: "id")
 *     since_hours?: number,
 *     date_field?: string,            // for since_hours filter (default: "created_at" or "published_at")
 *   }
 */

import { callTool, entityIdsOfType, fetchSeenSignalTags } from '@agent-crm/tools';
import type { Connector, ConnectorContext, ConnectorResult } from '../types.ts';

interface WatchEntity { entity_id: string; name: string; aliases?: string[] }

export { apiCallMeta as meta } from '../registry_meta.ts';

function getPath(obj: unknown, path: string | undefined): unknown {
  if (!path) return obj;
  const parts = path.split('.');
  let cur: any = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function interpolateHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = v.replace(/\$\{env:([A-Z0-9_]+)\}/g, (_m, name) => process.env[name] ?? '');
  }
  return out;
}

function normalizeDomain(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch { return null; }
}

const apiCall: Connector = async (ctx: ConnectorContext): Promise<ConnectorResult> => {
  const result: ConnectorResult = { signals_created: 0, entities_created: 0, skipped: 0, errors: [] };
  const url = (ctx.config.url as string)?.trim();
  if (!url) { result.errors.push('config.url required'); return result; }
  const method = ((ctx.config.method as string) ?? 'GET').toUpperCase();
  const headersIn = (ctx.config.headers as Record<string, string> | string | null) ?? {};
  let headers: Record<string, string> = {};
  if (typeof headersIn === 'string' && headersIn.trim()) {
    try { headers = JSON.parse(headersIn); } catch { result.errors.push('headers is not valid JSON'); return result; }
  } else if (typeof headersIn === 'object' && headersIn !== null) {
    headers = headersIn as Record<string, string>;
  }
  headers = interpolateHeaders(headers);
  const bodyRaw = ctx.config.body as string | object | null | undefined;
  let body: string | undefined;
  if (typeof bodyRaw === 'string' && bodyRaw.trim().length) body = bodyRaw;
  else if (typeof bodyRaw === 'object' && bodyRaw !== null) body = JSON.stringify(bodyRaw);

  const items_path = (ctx.config.items_path as string) ?? '';
  const id_field = ((ctx.config.id_field as string) ?? 'id');
  const title_field = ((ctx.config.title_field as string) ?? 'title');
  const body_field = ((ctx.config.body_field as string) ?? 'description');
  const date_field = ((ctx.config.date_field as string) ?? 'created_at');
  const since_hours = (ctx.config.since_hours as number) ?? 168;
  const cutoffMs = Date.now() - since_hours * 3600 * 1000;
  const watch = ((ctx.config.watch_entities as WatchEntity[]) ?? []);
  const intentRaw = (ctx.config.intent as string) ?? 'auto';
  const intent: 'watch' | 'discover' = intentRaw === 'discover' ? 'discover'
    : intentRaw === 'watch' ? 'watch'
    : (watch.length > 0 ? 'watch' : 'discover');
  const company_field = (ctx.config.company_field as string) ?? '';
  const domain_field = (ctx.config.domain_field as string) ?? '';
  const match_fields = ((ctx.config.match_fields as string[]) ?? ['title', 'name', 'description', 'body', 'content']).filter(Boolean);

  // Fetch
  let json: unknown;
  try {
    const res = await fetch(url, { method, headers, body });
    if (!res.ok) {
      result.errors.push(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return result;
    }
    json = await res.json();
  } catch (e) {
    result.errors.push(`fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }

  // Locate items array.
  const itemsRaw = getPath(json, items_path);
  let items: any[];
  if (Array.isArray(itemsRaw)) items = itemsRaw;
  else if (itemsRaw && typeof itemsRaw === 'object') items = [itemsRaw];
  else { result.errors.push(`items_path "${items_path}" did not resolve to an array or object`); return result; }

  // Dedup against signals seen in window.
  const seen = await fetchSeenSignalTags(ctx.supabase, {
    workspace_id: ctx.workspace_id,
    type: 'api_call',
    sinceISO: new Date(cutoffMs).toISOString(),
  });
  const seenIds = new Set<string>();
  for (const s of seen) {
    const id = (s.structured_tags as { item_id?: string } | null)?.item_id;
    if (id) seenIds.add(id);
  }

  // Pre-fetch entities for discover mode.
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

  const sourceActor = { workspace_id: ctx.workspace_id, actor_kind: 'agent' as const, actor_id: `source:api_call:${ctx.source_id.slice(0, 8)}` };

  for (const item of items) {
    const item_id = String(getPath(item, id_field) ?? '');
    if (!item_id || seenIds.has(item_id)) { result.skipped++; continue; }

    // Recency filter
    const dateVal = getPath(item, date_field) as string | number | undefined;
    if (dateVal) {
      const t = typeof dateVal === 'number' ? dateVal * (dateVal < 1e12 ? 1000 : 1) : Date.parse(String(dateVal));
      if (Number.isFinite(t) && t < cutoffMs) { result.skipped++; continue; }
    }

    const title = String(getPath(item, title_field) ?? '');
    const body_text = String(getPath(item, body_field) ?? '');

    let entity_id: string;
    let matched_alias: string;

    if (intent === 'watch') {
      const haystack = match_fields.map((f) => String(getPath(item, f) ?? '')).join(' ').toLowerCase();
      const matched = watch.find((w) => {
        const cands = [w.name, ...(w.aliases ?? [])].filter(Boolean).map((s) => s.toLowerCase());
        return cands.some((c) => haystack.includes(c));
      });
      if (!matched) { result.skipped++; continue; }
      entity_id = matched.entity_id;
      matched_alias = matched.name;
    } else {
      const companyName = company_field ? String(getPath(item, company_field) ?? '').trim() : '';
      if (!companyName) { result.skipped++; continue; }
      const domainRaw = domain_field ? String(getPath(item, domain_field) ?? '') : '';
      const domain = normalizeDomain(domainRaw) ?? normalizeDomain(String(getPath(item, 'url') ?? ''));

      let existing = domain ? entitiesByDomain.get(domain) : undefined;
      if (!existing) existing = entitiesByName.get(companyName.toLowerCase());

      if (existing) {
        entity_id = existing.id;
        matched_alias = existing.name;
      } else {
        const created = await callTool(ctx.supabase, sourceActor, 'create_account', {
          name: companyName,
          attributes: {
            domain: domain ?? `${companyName.toLowerCase().replace(/[^a-z0-9]+/g, '')}.example`,
            _discovered_via: 'api_call',
            discovered_at: new Date().toISOString(),
            _source_url: url,
          },
        });
        if (!created.ok) { result.errors.push(`create_account failed for ${companyName}: ${created.error}`); continue; }
        entity_id = created.target_id;
        matched_alias = companyName;
        result.entities_created++;
        if (domain) entitiesByDomain.set(domain, { id: entity_id, name: companyName });
        entitiesByName.set(companyName.toLowerCase(), { id: entity_id, name: companyName });
      }
    }

    const r = await callTool(ctx.supabase, sourceActor, 'create_signal', {
      entity_id,
      type: 'api_call',
      magnitude: 0.55,
      body_for_embedding: title ? `${title} — ${body_text}` : body_text,
      structured_tags: {
        signal_source: 'api_call',
        source_id: ctx.source_id,
        source_url: url,
        item_id,
        item_url: getPath(item, 'url') ?? null,
        intent,
        matched_alias,
      },
    });
    if (r.ok) result.signals_created++;
    else result.errors.push(`create_signal failed: ${r.error}`);
  }

  return result;
};

export default apiCall;
