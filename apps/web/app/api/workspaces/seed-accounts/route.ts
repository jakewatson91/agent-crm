/**
 * Seed initial accounts into a workspace.
 *
 * Two modes today:
 *  - csv: caller passes parsed rows {name, domain?, attributes?}.
 *  - connector: caller picks a registered connector (currently 'yc'), passes
 *    a filter, and the endpoint pulls candidates via the connector's
 *    fetch_list-style export, then inserts the top N (sorted by the
 *    connector's own ranking — recency for YC).
 *
 * Both modes:
 *  - Dedup by normalized domain against existing workspace entities. Skips
 *    matches; returns the skipped count separately.
 *  - Insert via the create_account tool so events + projections fire.
 *  - For connector mode, attributes include canonical ground-truth keys
 *    (team_size, stage, founded_year, etc.) the scorer reads as hard facts.
 *
 * Search-discovery mode (Exa similarity) is deferred to the Phase 3
 * similarity-expansion job — same machinery, different trigger.
 */
import { NextResponse } from 'next/server';
import { createServerClient } from '@agent-crm/db';
import { callTool } from '@agent-crm/tools';
import { fetchYcCandidates, type YcFetchFilter, type YcCandidate } from '@agent-crm/inngest/functions/sources/connectors/yc';

export const runtime = 'nodejs';

interface CsvRow {
  name: string;
  domain?: string;
  attributes?: Record<string, unknown>;
}

interface SeedReq {
  workspace_id: string;
  mode: 'csv' | 'connector';
  // csv mode
  rows?: CsvRow[];
  // connector mode
  connector_type?: 'yc';
  filter?: Record<string, unknown>;
  n?: number;
}

function normalizeDomain(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch { return null; }
}

interface SeedCandidate {
  name: string;
  domain: string | null;
  attributes: Record<string, unknown>;
}

async function resolveCandidates(body: SeedReq): Promise<{ candidates: SeedCandidate[]; error?: string }> {
  const n = body.n ?? 100;

  if (body.mode === 'csv') {
    if (!Array.isArray(body.rows) || body.rows.length === 0) {
      return { candidates: [], error: 'csv mode requires non-empty rows[]' };
    }
    const candidates = body.rows.slice(0, n).map((r) => ({
      name: String(r.name ?? '').trim(),
      domain: normalizeDomain(r.domain),
      attributes: {
        ...(r.attributes ?? {}),
        ...(r.domain ? { domain: normalizeDomain(r.domain) } : {}),
      },
    })).filter((c) => c.name.length > 0);
    return { candidates };
  }

  if (body.mode === 'connector') {
    if (body.connector_type !== 'yc') {
      return { candidates: [], error: `connector_type '${body.connector_type ?? ''}' not supported in v0 (only 'yc')` };
    }
    let ycResults: YcCandidate[];
    try {
      ycResults = await fetchYcCandidates({
        ...(body.filter as YcFetchFilter ?? {}),
        limit: n,    // YC connector sorts by launched_at desc internally
      });
    } catch (e) {
      return { candidates: [], error: `yc fetch failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    const candidates = ycResults.map((c) => ({
      name: c.name,
      domain: c.domain,
      attributes: c.attributes,
    }));
    return { candidates };
  }

  return { candidates: [], error: `unknown mode '${body.mode}'` };
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as SeedReq | null;
  if (!body?.workspace_id || !body?.mode) {
    return NextResponse.json({ error: 'workspace_id and mode required' }, { status: 400 });
  }

  const supabase = createServerClient();

  const { candidates, error } = await resolveCandidates(body);
  if (error) return NextResponse.json({ error }, { status: 400 });
  if (candidates.length === 0) {
    return NextResponse.json({ ok: true, inserted: 0, skipped_existing: 0, sample_ids: [] });
  }

  // Dedup against existing accounts by normalized domain.
  const existing = await supabase
    .from('entities')
    .select('id, attributes')
    .eq('workspace_id', body.workspace_id)
    .eq('kind', 'account');
  if (existing.error) {
    return NextResponse.json({ error: `failed to load existing entities: ${existing.error.message}` }, { status: 500 });
  }
  const existingDomains = new Set<string>();
  for (const e of existing.data ?? []) {
    const d = ((e.attributes as { domain?: string } | null)?.domain ?? '').toLowerCase();
    if (d) existingDomains.add(d);
  }

  const actor = {
    workspace_id: body.workspace_id,
    actor_kind: 'system' as const,
    actor_id: `seed:${body.mode}`,
  };

  const sample_ids: string[] = [];
  let inserted = 0;
  let skipped_existing = 0;
  const errors: string[] = [];

  for (const c of candidates) {
    if (c.domain && existingDomains.has(c.domain)) {
      skipped_existing++;
      continue;
    }
    const created = await callTool(supabase, actor, 'create_account', {
      name: c.name,
      attributes: c.attributes,
    });
    if (!created.ok) {
      errors.push(`${c.name}: ${created.error}`);
      continue;
    }
    inserted++;
    if (c.domain) existingDomains.add(c.domain);
    if (sample_ids.length < 5) sample_ids.push(created.target_id);
  }

  return NextResponse.json({
    ok: true,
    inserted,
    skipped_existing,
    sample_ids,
    ...(errors.length ? { errors: errors.slice(0, 10) } : {}),
  });
}
