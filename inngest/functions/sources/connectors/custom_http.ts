/**
 * custom_http connector — connectors as data.
 *
 * This is the generic "fetch + LLM-extract" engine. A workspace defines a
 * declarative spec (URL, response_path, extraction prompt) in sources.config
 * and this connector runs it. No code changes per vertical.
 *
 * Spec shape (sources.config):
 *   {
 *     fetch: {
 *       url: string,                                 // required
 *       method?: 'GET' | 'POST',                     // default GET
 *       headers?: Record<string, string>,            // ${env:NAME} interpolated
 *       body?: string | object,                      // optional, for POST
 *       response_path?: string,                      // dot path to the array. Empty = body itself is the array
 *     },
 *     extract: {
 *       system_prompt: string,                       // required. Tells LLM what to extract + output shape
 *       batch_size?: number,                         // default 10 items per LLM call
 *       model?: string,                              // default 'gpt-4o-mini'
 *     },
 *     signal?: {
 *       type?: string,                               // default 'custom_http'
 *       magnitude?: number,                          // default 0.55
 *     },
 *     dedup?: {
 *       since_hours?: number,                        // default 168
 *       item_id_path?: string,                       // dot path on each item to a stable id. If unset, hashes the item.
 *     }
 *   }
 *
 * LLM output contract (the spec's system_prompt MUST instruct the LLM to emit this):
 *   {
 *     "entities": [
 *       {
 *         "name": "Apollo.io",
 *         "domain": "apollo.io",              // optional
 *         "facts": [
 *           { "predicate": "hiring_for", "object_text": "RevOps", "confidence": 0.9 }
 *         ],
 *         "signal_body": "Apollo hiring senior RevOps to scale outbound"
 *       }
 *     ],
 *     "rejected": [
 *       { "item_index": 3, "reason": "no_company_mentioned" }
 *     ]
 *   }
 *
 * Engine is intentionally not opinionated about WHAT the entities or facts
 * mean — that's the spec's job. Vertical-neutral.
 */

import { createHash } from 'node:crypto';
import { callTool } from '@agent-crm/tools';
import { chatComplete } from '@agent-crm/primitives';
import type { Connector, ConnectorContext, ConnectorResult, ConnectorMeta } from '../types.js';

interface CustomHttpSpec {
  fetch: {
    url: string;
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string | object;
    response_path?: string;
  };
  extract: {
    system_prompt: string;
    batch_size?: number;
    model?: string;
  };
  signal?: {
    type?: string;
    magnitude?: number;
  };
  dedup?: {
    since_hours?: number;
    item_id_path?: string;
  };
}

interface ExtractedEntity {
  name: string;
  domain?: string;
  facts?: Array<{ predicate: string; object_text: string; confidence?: number }>;
  signal_body?: string;
}

interface ExtractedBatch {
  entities?: ExtractedEntity[];
  rejected?: Array<{ item_index: number; reason: string }>;
}

export const meta: ConnectorMeta = {
  type: 'custom_http',
  label: 'Custom HTTP (LLM extract)',
  description:
    'Fetch any URL on a schedule, batch the response through an LLM with your extraction prompt, and assert entities + facts. The connector wizard generates the spec from a URL + a free-text description; no code required.',
  category: 'tool',
  emits_signal_source: 'custom_http',
  schedule_cron: '0 */6 * * *',
  config_schema: {
    fields: [
      { name: 'fetch', label: 'Fetch spec (JSON)', kind: 'textarea', required: true,
        help: 'Object with url, method, headers, body, response_path. Use ${env:NAME} for env vars.' },
      { name: 'extract', label: 'Extract spec (JSON)', kind: 'textarea', required: true,
        help: 'Object with system_prompt, batch_size, model. The prompt MUST tell the LLM the exact output JSON shape (see custom_http.ts docs).' },
      { name: 'signal', label: 'Signal spec (JSON, optional)', kind: 'textarea',
        help: 'Object with type, magnitude. Optional — defaults shown.' },
      { name: 'dedup', label: 'Dedup spec (JSON, optional)', kind: 'textarea',
        help: 'Object with since_hours, item_id_path. Without item_id_path the item itself is hashed for dedup.' },
    ],
  },
};

function getPath(obj: unknown, path: string | undefined): unknown {
  if (!path) return obj;
  let cur: any = obj;
  for (const p of path.split('.')) {
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

function hashItem(item: unknown): string {
  return createHash('sha256').update(JSON.stringify(item)).digest('hex').slice(0, 32);
}

function parseSpecField<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    try { return JSON.parse(trimmed) as T; } catch { return fallback; }
  }
  if (typeof value === 'object') return value as T;
  return fallback;
}

const customHttp: Connector = async (ctx: ConnectorContext): Promise<ConnectorResult> => {
  const result: ConnectorResult = { signals_created: 0, entities_created: 0, skipped: 0, errors: [] };

  const fetchSpec = parseSpecField<CustomHttpSpec['fetch']>(ctx.config.fetch, { url: '' });
  const extractSpec = parseSpecField<CustomHttpSpec['extract']>(ctx.config.extract, { system_prompt: '' });
  const signalSpec = parseSpecField<NonNullable<CustomHttpSpec['signal']>>(ctx.config.signal, {});
  const dedupSpec = parseSpecField<NonNullable<CustomHttpSpec['dedup']>>(ctx.config.dedup, {});

  if (!fetchSpec.url) { result.errors.push('config.fetch.url required'); return result; }
  if (!extractSpec.system_prompt) { result.errors.push('config.extract.system_prompt required'); return result; }

  // Build request
  const method = (fetchSpec.method ?? 'GET').toUpperCase();
  const headers = interpolateHeaders(fetchSpec.headers ?? {});
  let body: string | undefined;
  if (typeof fetchSpec.body === 'string' && fetchSpec.body.trim().length) body = fetchSpec.body;
  else if (typeof fetchSpec.body === 'object' && fetchSpec.body !== null) body = JSON.stringify(fetchSpec.body);

  let json: unknown;
  try {
    const res = await fetch(fetchSpec.url, { method, headers, body });
    if (!res.ok) {
      result.errors.push(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return result;
    }
    json = await res.json();
  } catch (e) {
    result.errors.push(`fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }

  // Walk response_path → items array
  const itemsRaw = getPath(json, fetchSpec.response_path);
  let items: any[];
  if (Array.isArray(itemsRaw)) items = itemsRaw;
  else if (itemsRaw && typeof itemsRaw === 'object') items = [itemsRaw];
  else {
    result.errors.push(`response_path "${fetchSpec.response_path ?? ''}" did not resolve to an array or object`);
    return result;
  }

  // Dedup: hash each item (or pluck spec'd id), check against prior signals' structured_tags.item_id
  const sinceHours = dedupSpec.since_hours ?? 168;
  const cutoffMs = Date.now() - sinceHours * 3600 * 1000;
  const signalType = signalSpec.type ?? 'custom_http';
  const seen = await ctx.supabase
    .from('signals')
    .select('structured_tags')
    .eq('workspace_id', ctx.workspace_id)
    .eq('type', signalType)
    .gte('observed_at', new Date(cutoffMs).toISOString());
  const seenIds = new Set<string>();
  for (const s of seen.data ?? []) {
    const id = (s.structured_tags as { item_id?: string } | null)?.item_id;
    if (id) seenIds.add(id);
  }

  // Annotate items with their dedup id; drop already-seen.
  const fresh: Array<{ item: unknown; item_id: string }> = [];
  for (const item of items) {
    const rawId = dedupSpec.item_id_path ? String(getPath(item, dedupSpec.item_id_path) ?? '') : '';
    const item_id = rawId || hashItem(item);
    if (seenIds.has(item_id)) { result.skipped++; continue; }
    fresh.push({ item, item_id });
  }
  if (!fresh.length) return result;

  // Entity lookup caches for the batch (same pattern as api_call).
  const entitiesByDomain = new Map<string, { id: string; name: string }>();
  const entitiesByName = new Map<string, { id: string; name: string }>();
  const ents = await ctx.supabase
    .from('entities').select('id, name, attributes')
    .eq('workspace_id', ctx.workspace_id).eq('kind', 'account');
  for (const e of ents.data ?? []) {
    const d = (e.attributes as { domain?: string } | null)?.domain ?? null;
    if (d) entitiesByDomain.set(d.toLowerCase(), { id: e.id as string, name: e.name as string });
    entitiesByName.set((e.name as string).toLowerCase(), { id: e.id as string, name: e.name as string });
  }

  const sourceActor = {
    workspace_id: ctx.workspace_id, actor_kind: 'agent' as const,
    actor_id: `source:custom_http:${ctx.source_id.slice(0, 8)}`,
  };

  const batchSize = Math.max(1, extractSpec.batch_size ?? 10);
  const model = extractSpec.model ?? 'gpt-4o-mini';
  const magnitude = signalSpec.magnitude ?? 0.55;

  for (let i = 0; i < fresh.length; i += batchSize) {
    const batch = fresh.slice(i, i + batchSize);
    // We pass items with an index so the LLM can refer to them in `rejected`.
    const userPayload = batch.map((b, idx) => ({ item_index: idx, item: b.item }));

    let extracted: ExtractedBatch;
    try {
      const llm = await chatComplete({
        model,
        max_tokens: 1500,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: extractSpec.system_prompt },
          { role: 'user', content: `ITEMS (return JSON per the system prompt):\n${JSON.stringify(userPayload, null, 2)}` },
        ],
      });
      extracted = JSON.parse(llm.text) as ExtractedBatch;
    } catch (e) {
      result.errors.push(`extract batch ${i / batchSize}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    const entities = extracted.entities ?? [];
    if (!Array.isArray(entities)) {
      result.errors.push(`batch ${i / batchSize}: extract did not return entities[] array`);
      continue;
    }

    for (let k = 0; k < entities.length; k++) {
      const e = entities[k];
      if (!e || typeof e.name !== 'string' || !e.name.trim()) { result.skipped++; continue; }
      const item_id = batch[Math.min(k, batch.length - 1)]?.item_id ?? hashItem(e);
      const name = e.name.trim();
      const domain = normalizeDomain(e.domain ?? null);

      // Lookup or create entity
      let entity_id: string;
      const existing = (domain && entitiesByDomain.get(domain)) ?? entitiesByName.get(name.toLowerCase());
      if (existing) {
        entity_id = existing.id;
      } else {
        const created = await callTool(ctx.supabase, sourceActor, 'create_account', {
          name,
          attributes: {
            domain: domain ?? `${name.toLowerCase().replace(/[^a-z0-9]+/g, '')}.example`,
            discovered_via: 'custom_http',
            discovered_at: new Date().toISOString(),
            source_url: fetchSpec.url,
          },
        });
        if (!created.ok) { result.errors.push(`create_account ${name}: ${created.error}`); continue; }
        entity_id = created.target_id;
        result.entities_created++;
        if (domain) entitiesByDomain.set(domain, { id: entity_id, name });
        entitiesByName.set(name.toLowerCase(), { id: entity_id, name });
      }

      // Assert facts
      for (const f of e.facts ?? []) {
        if (!f?.predicate || !f?.object_text) continue;
        const conf = typeof f.confidence === 'number' ? Math.max(0, Math.min(1, f.confidence)) : 0.7;
        await callTool(ctx.supabase, sourceActor, 'assert_fact', {
          subject_entity: entity_id,
          predicate: String(f.predicate).toLowerCase().replace(/\s+/g, '_'),
          object_text: String(f.object_text),
          confidence: conf,
        });
      }

      // Emit one signal per extracted entity (drives downstream subscriptions).
      const signalBody = e.signal_body ?? `Custom-HTTP signal for ${name}`;
      const sig = await callTool(ctx.supabase, sourceActor, 'create_signal', {
        entity_id,
        type: signalType,
        magnitude,
        body_for_embedding: signalBody,
        structured_tags: {
          signal_source: signalType,
          source_url: fetchSpec.url,
          item_id,
          matched_alias: name,
        },
      });
      if (sig.ok) result.signals_created++;
      else result.errors.push(`create_signal ${name}: ${sig.error}`);
    }
  }

  return result;
};

export default customHttp;
