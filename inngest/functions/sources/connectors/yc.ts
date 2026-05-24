/**
 * Y Combinator directory connector.
 *
 * Pulls companies from yc-oss/api (community-maintained JSON mirrors of YC's directory).
 * For each company: dedup by domain, upsert as account entity, emit a signal so
 * agents can react to "new YC company in our ICP" or "YC directory updated" events.
 *
 * Config shape:
 *   {
 *     batches?: string[],          // e.g. ["W25","S25"]; default = all currently active
 *     statuses?: string[],         // ["Active"] | ["Active","Acquired",...]; default ["Active"]
 *     industries?: string[],       // optional industry filter (substring match on YC's industry field)
 *     max_per_run?: number,        // safety cap; default 200
 *   }
 *
 * Dedup strategy: domain-based. If an entity with the same domain (case-insensitive,
 * www-stripped) already exists in the workspace, we skip creating a new entity and
 * emit signal type='yc_directory_update'. Otherwise we create the entity and emit
 * signal type='yc_new_company'.
 */

import { createHash } from 'node:crypto';
import { callTool } from '@agent-crm/tools';
import type { Connector, ConnectorContext, ConnectorResult } from '../types.js';
import { upsertEntityEmbedding } from '../utils.js';

// Fields whose change we treat as a meaningful YC delta. team_size, hiring
// status, YC status, batch (rare but possible), and stage are the things an
// agent should react to. one_liner included so a company that materially
// rewrites their pitch produces a re-eval.
function ycSnapshotHash(c: YcCompany): string {
  const tracked = {
    team_size: c.team_size ?? null,
    status: c.status,
    isHiring: c.isHiring ?? false,
    batch: c.batch,
    stage: c.stage ?? null,
    top_company: c.top_company ?? false,
    one_liner: c.one_liner ?? '',
  };
  return createHash('sha256').update(JSON.stringify(tracked)).digest('hex').slice(0, 16);
}

// yc-oss publishes per-batch JSON. The "all active" file is the simplest entry point.
const YC_ALL_URL = 'https://yc-oss.github.io/api/companies/all.json';

interface YcCompany {
  id: number;
  name: string;
  slug: string;
  former_names?: string[];
  small_logo_thumb_url?: string;
  website?: string;
  all_locations?: string;
  long_description?: string;
  one_liner?: string;
  team_size?: number;
  industry?: string;
  subindustry?: string;
  launched_at?: number;
  tags?: string[];
  tags_highlighted?: string[];
  top_company?: boolean;
  isHiring?: boolean;
  nonprofit?: boolean;
  batch: string;
  status: string;
  industries?: string[];
  regions?: string[];
  stage?: string;
  app_video_public?: boolean;
  demo_day_video_public?: boolean;
  app_answers?: unknown;
  question_answers?: boolean;
  url?: string;
}

export { ycMeta as meta } from '../registry_meta.js';

/**
 * Lookup-only API for the seed_accounts endpoint. Fetches + filters YC
 * directory candidates and returns ready-to-insert shapes. Does NOT touch the
 * database or emit signals. The seed endpoint handles ranking + insertion.
 */
export interface YcFetchFilter {
  batches?: string[];
  statuses?: string[];
  industries?: string[];
  team_size_min?: number;
  team_size_max?: number;
  stages?: string[];
  limit?: number;        // raw cap before downstream ranking; default 500
}

export interface YcCandidate {
  name: string;
  slug: string;
  domain: string | null;
  one_liner: string | null;
  long_description: string | null;
  /** Pre-built attribute object — drop into entity.attributes on insert. */
  attributes: Record<string, unknown>;
  /** Text suitable for ranking (embedding similarity vs workspace.about). */
  rank_text: string;
}

export async function fetchYcCandidates(filter: YcFetchFilter): Promise<YcCandidate[]> {
  const batches = (filter.batches ?? []).filter(Boolean);
  const statuses = (filter.statuses ?? ['Active']).filter(Boolean);
  const industries = (filter.industries ?? []).filter(Boolean);
  const stages = (filter.stages ?? []).filter(Boolean);
  const tsMin = filter.team_size_min;
  const tsMax = filter.team_size_max;
  const limit = filter.limit ?? 500;

  const r = await fetch(YC_ALL_URL);
  if (!r.ok) throw new Error(`yc-oss fetch ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const companies = (await r.json()) as YcCompany[];

  const filtered = companies.filter((c) => {
    if (!batchMatches(c.batch, batches)) return false;
    if (statuses.length && !statuses.includes(c.status)) return false;
    if (industries.length) {
      const hay = `${c.industry ?? ''} ${(c.industries ?? []).join(' ')} ${c.subindustry ?? ''}`.toLowerCase();
      if (!industries.some((i) => hay.includes(i.toLowerCase()))) return false;
    }
    if (stages.length && (!c.stage || !stages.includes(c.stage))) return false;
    if (typeof tsMin === 'number' && (c.team_size ?? 0) < tsMin) return false;
    if (typeof tsMax === 'number' && (c.team_size ?? Number.POSITIVE_INFINITY) > tsMax) return false;
    return true;
  });

  return filtered
    .sort((a, b) => (b.launched_at ?? 0) - (a.launched_at ?? 0))
    .slice(0, limit)
    .map((c) => ({
      name: c.name,
      slug: c.slug,
      domain: normalizeDomain(c.website),
      one_liner: c.one_liner ?? null,
      long_description: c.long_description ?? null,
      attributes: {
        // Ground-truth fields (canonical names — see scoring.ts GROUND_TRUTH_KEYS)
        team_size: c.team_size ?? null,
        stage: c.stage ?? null,
        industry: c.industry ?? null,
        location: c.all_locations ?? null,
        // YC-specific
        domain: normalizeDomain(c.website),
        subindustry: c.subindustry ?? null,
        industries: c.industries ?? [],
        regions: c.regions ?? [],
        yc_batch: c.batch,
        yc_status: c.status,
        yc_slug: c.slug,
        yc_url: c.url ?? `https://www.ycombinator.com/companies/${c.slug}`,
        website: c.website ?? null,
        top_company: c.top_company ?? false,
        is_hiring: c.isHiring ?? false,
        one_liner: c.one_liner ?? null,
        description: c.long_description ?? null,
        tags: c.tags ?? [],
        yc_snapshot_hash: ycSnapshotHash(c),
      },
      rank_text: `${c.name} (${c.batch}): ${c.one_liner ?? ''} ${c.long_description ?? ''} industry=${c.industry ?? ''} stage=${c.stage ?? ''}`,
    }));
}

function normalizeDomain(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch { return null; }
}

/** Build the set of forms a YC batch matches against. yc-oss uses "Winter 2025" but
 *  users often type "W25". Accept both. */
function batchAliases(batch: string): string[] {
  const out = new Set([batch.toLowerCase()]);
  const m = batch.match(/^(winter|summer|spring|fall)\s+(\d{4})$/i);
  if (m) {
    const season = m[1]!.toLowerCase();
    const year = m[2]!.slice(-2);
    out.add(`${season[0]}${year}`);                 // w25
    out.add(`${season.slice(0, 1).toUpperCase()}${year}`.toLowerCase()); // w25 (lowercased)
  }
  return [...out];
}

function batchMatches(yc_batch: string, user_input: string[]): boolean {
  if (!user_input.length) return true;
  const aliases = batchAliases(yc_batch);
  return user_input.some((b) => aliases.includes(b.toLowerCase()));
}

const yc: Connector = async (ctx: ConnectorContext): Promise<ConnectorResult> => {
  const result: ConnectorResult = { signals_created: 0, entities_created: 0, skipped: 0, errors: [] };
  let skipped_unchanged = 0;
  const batches = ((ctx.config.batches as string[]) ?? []).filter(Boolean);
  const statuses = ((ctx.config.statuses as string[]) ?? ['Active']).filter(Boolean);
  const industries = ((ctx.config.industries as string[]) ?? []).filter(Boolean);
  const max_per_run = (ctx.config.max_per_run as number) ?? 200;

  let companies: YcCompany[];
  try {
    const r = await fetch(YC_ALL_URL);
    if (!r.ok) {
      result.errors.push(`yc-oss fetch ${r.status}: ${await r.text().then((t) => t.slice(0, 200))}`);
      return result;
    }
    companies = (await r.json()) as YcCompany[];
  } catch (e) {
    result.errors.push(`yc-oss fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }

  // Filter. Batches accepts both "Winter 2025" and short "W25" forms.
  const filtered = companies.filter((c) => {
    if (!batchMatches(c.batch, batches)) return false;
    if (statuses.length && !statuses.includes(c.status)) return false;
    if (industries.length) {
      const hay = `${c.industry ?? ''} ${(c.industries ?? []).join(' ')} ${c.subindustry ?? ''}`.toLowerCase();
      if (!industries.some((i) => hay.includes(i.toLowerCase()))) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    return result;
  }

  // Slice to max_per_run. Sort by launched_at desc so newer companies come first.
  const sorted = filtered.sort((a, b) => (b.launched_at ?? 0) - (a.launched_at ?? 0)).slice(0, max_per_run);

  // Pre-fetch existing entities in this workspace (by domain) for dedup.
  const existing = await ctx.supabase
    .from('entities')
    .select('id, name, attributes')
    .eq('workspace_id', ctx.workspace_id)
    .eq('kind', 'account');
  if (existing.error) {
    result.errors.push(`failed to fetch existing entities: ${existing.error.message}`);
    return result;
  }
  const byDomain = new Map<string, { id: string; name: string; yc_snapshot_hash: string | null }>();
  for (const e of existing.data ?? []) {
    const attrs = (e.attributes as { domain?: string; yc_snapshot_hash?: string } | null) ?? {};
    if (attrs.domain) {
      byDomain.set(attrs.domain.toLowerCase(), {
        id: e.id as string,
        name: e.name as string,
        yc_snapshot_hash: attrs.yc_snapshot_hash ?? null,
      });
    }
  }

  for (const c of sorted) {
    const domain = normalizeDomain(c.website) ?? `${c.slug}.yc.example`;
    const existingEnt = byDomain.get(domain);
    const snapshot_hash = ycSnapshotHash(c);

    let entity_id: string;
    let isNew = false;

    if (existingEnt) {
      entity_id = existingEnt.id;
      // Skip emission when nothing tracked has changed since last run.
      if (existingEnt.yc_snapshot_hash === snapshot_hash) {
        skipped_unchanged++;
        continue;
      }
      // Material change detected. Update the snapshot hash so the next run
      // measures change against this run, not the original create.
      const upd = await ctx.supabase.from('entities')
        .update({ attributes: {
          ...(existing.data?.find((row) => row.id === entity_id)?.attributes as object ?? {}),
          yc_snapshot_hash: snapshot_hash,
          team_size: c.team_size ?? null,
          yc_status: c.status,
          is_hiring: c.isHiring ?? false,
          stage: c.stage ?? null,
          one_liner: c.one_liner ?? null,
        } })
        .eq('id', entity_id);
      if (upd.error) result.errors.push(`update attrs failed for ${c.name}: ${upd.error.message}`);
    } else {
      const created = await callTool(
        ctx.supabase,
        { workspace_id: ctx.workspace_id, actor_kind: 'agent', actor_id: `source:yc:${ctx.source_id.slice(0, 8)}` },
        'create_account',
        {
          name: c.name,
          attributes: {
            domain,
            industry: c.industry ?? null,
            subindustry: c.subindustry ?? null,
            industries: c.industries ?? [],
            regions: c.regions ?? [],
            location: c.all_locations ?? null,
            yc_batch: c.batch,
            yc_status: c.status,
            yc_slug: c.slug,
            yc_url: c.url ?? `https://www.ycombinator.com/companies/${c.slug}`,
            website: c.website ?? null,
            team_size: c.team_size ?? null,
            top_company: c.top_company ?? false,
            is_hiring: c.isHiring ?? false,
            stage: c.stage ?? null,
            one_liner: c.one_liner ?? null,
            description: c.long_description ?? null,
            tags: c.tags ?? [],
            yc_snapshot_hash: snapshot_hash,
          },
        },
      );
      if (!created.ok) {
        result.errors.push(`create_account failed for ${c.name}: ${created.error}`);
        continue;
      }
      entity_id = created.target_id;
      result.entities_created++;
      isNew = true;
      byDomain.set(domain, { id: entity_id, name: c.name, yc_snapshot_hash: snapshot_hash });

      // Embed the new entity so query() and similarity-based scoring can find it.
      try {
        const embedText = `${c.name} (${c.batch}): ${c.one_liner ?? ''} ${c.long_description ?? ''} industry=${c.industry ?? ''} location=${c.all_locations ?? ''} stage=${c.stage ?? ''} hiring=${c.isHiring ? 'yes' : 'no'}`;
        await upsertEntityEmbedding(ctx.supabase, entity_id, embedText);
      } catch (e) {
        result.errors.push(`embed failed for ${c.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Emit a signal so agents can score / enrich. New companies get a stronger magnitude.
    const signal = await callTool(
      ctx.supabase,
      { workspace_id: ctx.workspace_id, actor_kind: 'agent', actor_id: `source:yc:${ctx.source_id.slice(0, 8)}` },
      'create_signal',
      {
        entity_id,
        type: isNew ? 'yc_new_company' : 'yc_directory_update',
        magnitude: isNew ? 0.85 : 0.4,
        body_for_embedding: `${c.name} (YC ${c.batch}, ${c.status}). ${c.one_liner ?? ''} ${c.long_description ?? ''} Industry: ${c.industry ?? '-'}. Location: ${c.all_locations ?? '-'}. Hiring: ${c.isHiring ? 'yes' : 'no'}.`,
        structured_tags: {
          signal_source: 'yc',
          source_id: ctx.source_id,
          yc_batch: c.batch,
          yc_status: c.status,
          industry: c.industry ?? null,
          is_hiring: c.isHiring ?? false,
          top_company: c.top_company ?? false,
          stage: c.stage ?? null,
        },
      },
    );
    if (signal.ok) result.signals_created++;
    else result.errors.push(`create_signal failed for ${c.name}: ${signal.error}`);
  }

  // skipped counts both the cap overflow and unchanged-companies skips. The
  // sweep cares about signals_created and entities_created; this counter is
  // just for the source's last_run_summary so it's clear why volume looks low.
  result.skipped = (filtered.length - sorted.length) + skipped_unchanged;

  return result;
};

export default yc;
