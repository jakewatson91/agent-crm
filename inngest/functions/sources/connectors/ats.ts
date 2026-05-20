/**
 * ATS hiring connector. Watches public job boards on Greenhouse, Lever,
 * Ashby, and Workable for every active workspace account. A new role
 * appearing on a watched company's board = a `hiring_post` signal (high-
 * intent sales trigger — they're growing, money is being spent on people).
 *
 * Discovery is lazy + per-entity: on first encounter, probe each provider
 * for a board matching the entity's slug; store the discovered provider +
 * slug on `entity.attributes.ats` so subsequent runs only hit the known
 * endpoint. If nothing matches, store `attributes.ats = 'none'` so we
 * don't re-probe forever.
 *
 * Slug derivation: lowercase the entity name, strip everything that isn't
 * a-z/0-9, plus a couple of common variants (hyphenated, with-spaces-as-
 * dashes). YC entity domains aren't reliable for ATS slugs because most
 * companies put their jobs page at `<company>.<provider>.com`, not under
 * their own domain.
 *
 * Cron: daily (jobs change on human timescales — running hourly burns
 * requests for ~zero new signal).
 *
 * Cost: free. No API keys. All endpoints are public job board exports.
 *
 * Trade-off: by passing entity.attributes around, this connector creates
 * write-side state on entities (the discovered ats hint). Idempotent —
 * re-runs only update when the discovered value changes.
 */
import { callTool } from '@agent-crm/tools';
import type { Connector, ConnectorContext, ConnectorResult } from '../types.js';
import { getWatchedAccounts } from '../utils.js';

export { atsMeta as meta } from '../registry_meta.js';

type Provider = 'greenhouse' | 'lever' | 'ashby' | 'workable';

interface AtsHint {
  provider: Provider | 'none';
  slug?: string;
  discovered_at: string;
  // How the slug was verified to belong to this entity. Older hints written
  // before verification existed have no field — treated as 'unverified'.
  verification?: 'domain_match' | 'domain_missing' | 'unverified';
}

interface JobPosting {
  external_id: string;          // provider's job id
  title: string;
  url: string;
  location?: string | null;
  department?: string | null;
  posted_at?: string | null;
}

interface JobsFetchResult { ok: boolean; jobs: JobPosting[]; status: number }

// ---- Per-provider fetchers ----

async function fetchGreenhouse(slug: string): Promise<JobsFetchResult> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs`;
  const r = await fetch(url);
  if (!r.ok) return { ok: false, jobs: [], status: r.status };
  const j = await r.json() as { jobs?: Array<{ id: number; title: string; absolute_url: string; location?: { name?: string }; updated_at?: string }> };
  const jobs: JobPosting[] = (j.jobs ?? []).map((p) => ({
    external_id: `gh:${p.id}`,
    title: p.title,
    url: p.absolute_url,
    location: p.location?.name ?? null,
    posted_at: p.updated_at ?? null,
  }));
  return { ok: true, jobs, status: 200 };
}

async function fetchLever(slug: string): Promise<JobsFetchResult> {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`;
  const r = await fetch(url);
  if (!r.ok) return { ok: false, jobs: [], status: r.status };
  const arr = await r.json() as Array<{ id: string; text: string; hostedUrl: string; categories?: { location?: string; team?: string }; createdAt?: number }>;
  const jobs: JobPosting[] = arr.map((p) => ({
    external_id: `lv:${p.id}`,
    title: p.text,
    url: p.hostedUrl,
    location: p.categories?.location ?? null,
    department: p.categories?.team ?? null,
    posted_at: p.createdAt ? new Date(p.createdAt).toISOString() : null,
  }));
  return { ok: true, jobs, status: 200 };
}

async function fetchAshby(slug: string): Promise<JobsFetchResult> {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`;
  const r = await fetch(url);
  if (!r.ok) return { ok: false, jobs: [], status: r.status };
  const j = await r.json() as { jobs?: Array<{ id: string; title: string; jobUrl: string; locationName?: string; departmentName?: string; publishedAt?: string }> };
  const jobs: JobPosting[] = (j.jobs ?? []).map((p) => ({
    external_id: `ah:${p.id}`,
    title: p.title,
    url: p.jobUrl,
    location: p.locationName ?? null,
    department: p.departmentName ?? null,
    posted_at: p.publishedAt ?? null,
  }));
  return { ok: true, jobs, status: 200 };
}

async function fetchWorkable(slug: string): Promise<JobsFetchResult> {
  const url = `https://apply.workable.com/api/v3/accounts/${encodeURIComponent(slug)}/jobs`;
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: '' }) });
  if (!r.ok) return { ok: false, jobs: [], status: r.status };
  const j = await r.json() as { results?: Array<{ id: string; title: string; shortcode?: string; locations?: Array<{ location_str?: string }>; department?: string; published_on?: string }> };
  const jobs: JobPosting[] = (j.results ?? []).map((p) => ({
    external_id: `wk:${p.id}`,
    title: p.title,
    url: `https://apply.workable.com/${encodeURIComponent(slug)}/j/${p.shortcode ?? p.id}/`,
    location: p.locations?.[0]?.location_str ?? null,
    department: p.department ?? null,
    posted_at: p.published_on ?? null,
  }));
  return { ok: true, jobs, status: 200 };
}

const FETCHERS: Record<Provider, (slug: string) => Promise<JobsFetchResult>> = {
  greenhouse: fetchGreenhouse,
  lever: fetchLever,
  ashby: fetchAshby,
  workable: fetchWorkable,
};

// ---- Slug derivation ----

function deriveSlugs(name: string, domain?: string): string[] {
  const variants: string[] = [];
  // Domain-derived slugs go first — much stronger signal than the name.
  // "silahq.com" → ["silahq"]. Avoids collisions like YC's "Sila" vs the
  // Pennsylvania home-services contractor that owns jobs.lever.co/sila.
  const host = normalizeDomain(domain);
  if (host) {
    const root = host.split('.')[0];                                  // silahq
    if (root && root.length >= 2) variants.push(root);
    variants.push(host.replace(/\./g, ''));                           // silahqcom
  }
  const base = name.toLowerCase().trim();
  variants.push(base.replace(/[^a-z0-9]/g, ''));                      // alphanumeric only
  variants.push(base.replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')); // hyphenated
  variants.push(base.replace(/\s+/g, ''));                            // lowercase no spaces
  return [...new Set(variants)].filter((s) => s.length >= 2);
}

function normalizeDomain(raw: string | undefined | null): string {
  if (!raw) return '';
  const stripped = String(raw).toLowerCase().trim()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '');
  return (stripped.split('/')[0] ?? '').split('?')[0] ?? '';
}

// ---- Verification ----
//
// Probing a slug only tells you "some company on this provider uses this
// slug." It does NOT tell you it's *our* company. Many short names collide:
// "Sila" → both YC W26 (silahq.com) and a Pennsylvania home-services
// contractor own jobs.lever.co/sila boards in spirit, but only the latter
// actually has the board. Without verification, every short-named entity
// risks attaching to a stranger's hiring data.
//
// Verification strategy: fetch the board's public landing page (and one
// sample job page) and confirm the entity's bare domain appears somewhere
// in the HTML. Every ATS we use renders the company website on the public
// board, so a domain match is a strong positive signal. No domain on the
// entity → can't verify → reject the probe.
const BOARD_PAGE_URL: Record<Provider, (slug: string) => string> = {
  greenhouse: (s) => `https://boards.greenhouse.io/${encodeURIComponent(s)}`,
  lever:      (s) => `https://jobs.lever.co/${encodeURIComponent(s)}`,
  ashby:      (s) => `https://jobs.ashbyhq.com/${encodeURIComponent(s)}`,
  workable:   (s) => `https://apply.workable.com/${encodeURIComponent(s)}`,
};

async function verifyBoardMatchesEntity(
  provider: Provider,
  slug: string,
  domain: string,
  sampleJob: JobPosting | undefined,
): Promise<boolean> {
  const target = normalizeDomain(domain);
  if (!target) return false;
  const urls = [BOARD_PAGE_URL[provider](slug)];
  if (sampleJob?.url) urls.push(sampleJob.url);
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'agent-crm-ats-discovery/1.0' } });
      if (!r.ok) continue;
      const html = (await r.text()).toLowerCase();
      if (html.includes(target)) return true;
    } catch {
      // try next url
    }
  }
  return false;
}

// ---- Connector ----

const ats: Connector = async (ctx: ConnectorContext): Promise<ConnectorResult> => {
  const result: ConnectorResult = { signals_created: 0, entities_created: 0, skipped: 0, errors: [] };

  const allowedProviders = ((ctx.config.providers as string[]) ?? ['greenhouse', 'lever', 'ashby', 'workable'])
    .filter((p): p is Provider => p in FETCHERS);
  const reprobe_days = (ctx.config.reprobe_days as number) ?? 30;
  const max_entities_per_run = (ctx.config.max_entities_per_run as number) ?? 200;

  // Load active accounts + their full entity rows (need attributes for the
  // ATS hint cache).
  const watch = await getWatchedAccounts(ctx.supabase, ctx.workspace_id);
  if (!watch.length) return result;
  const watchIds = watch.map((w) => w.entity_id);

  // Pull full entity rows for the watchlist (chunked to dodge any URL caps).
  const entityById = new Map<string, { id: string; name: string; attributes: Record<string, unknown> }>();
  for (let i = 0; i < watchIds.length; i += 200) {
    const chunk = watchIds.slice(i, i + 200);
    const r = await ctx.supabase.from('entities').select('id, name, attributes').in('id', chunk);
    for (const e of r.data ?? []) entityById.set(e.id as string, e as any);
  }

  // Order entities so those without a known ATS hint OR with stale 'none'
  // hints get probed first (amortized discovery).
  const ordered = watch.map((w) => entityById.get(w.entity_id)).filter(Boolean) as Array<{ id: string; name: string; attributes: Record<string, unknown> }>;
  const now = Date.now();
  const reprobeMs = reprobe_days * 86400_000;
  ordered.sort((a, b) => {
    const aHint = a.attributes.ats as AtsHint | undefined;
    const bHint = b.attributes.ats as AtsHint | undefined;
    const aPriority = !aHint ? 0 : (aHint.provider === 'none' && (now - Date.parse(aHint.discovered_at)) > reprobeMs ? 1 : 2);
    const bPriority = !bHint ? 0 : (bHint.provider === 'none' && (now - Date.parse(bHint.discovered_at)) > reprobeMs ? 1 : 2);
    return aPriority - bPriority;
  });

  const todo = ordered.slice(0, max_entities_per_run);
  const sourceActor = { workspace_id: ctx.workspace_id, actor_kind: 'agent' as const, actor_id: `source:ats:${ctx.source_id.slice(0, 8)}` };

  for (const ent of todo) {
    let hint = ent.attributes.ats as AtsHint | undefined;
    let provider: Provider | null = null;
    let slug: string | null = null;
    // If the discovery probe just fetched jobs successfully, reuse them
    // instead of re-fetching the same endpoint below.
    let prefetched: JobsFetchResult | undefined;

    // Use cached hint if fresh
    if (hint && hint.provider !== 'none' && hint.slug) {
      provider = hint.provider;
      slug = hint.slug;
    } else if (hint && hint.provider === 'none' && (now - Date.parse(hint.discovered_at)) < reprobeMs) {
      // Recently confirmed as not on any ATS — skip until reprobe window.
      result.skipped++;
      continue;
    } else {
      // Probe each allowed provider × each candidate slug. On a 200, verify
      // the board actually belongs to this entity (domain match) before
      // accepting. An unverified 200 is treated like a 404 — keep probing.
      const domain = normalizeDomain(ent.attributes.domain as string | undefined);
      const slugs = deriveSlugs(ent.name, domain);
      let firstJobs: JobPosting[] = [];
      let verification: AtsHint['verification'] = 'unverified';
      probe: for (const p of allowedProviders) {
        for (const s of slugs) {
          try {
            const r = await FETCHERS[p](s);
            if (!r.ok) {
              if (r.status !== 404) result.errors.push(`probe ${p}/${s} returned ${r.status} (non-fatal)`);
              continue;
            }
            if (!domain) {
              // Can't verify ownership without a domain. Don't trust the probe.
              result.errors.push(`probe ${p}/${s} matched but entity has no domain — skipping`);
              verification = 'domain_missing';
              continue;
            }
            const verified = await verifyBoardMatchesEntity(p, s, domain, r.jobs[0]);
            if (verified) {
              provider = p;
              slug = s;
              firstJobs = r.jobs;
              verification = 'domain_match';
              break probe;
            }
            result.errors.push(`probe ${p}/${s} matched but board does not mention ${domain} — rejected`);
          } catch (e) {
            result.errors.push(`probe ${p}/${s} threw: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
      // Persist hint (positive or negative) so future runs don't re-probe.
      const newHint: AtsHint = provider && slug
        ? { provider, slug, discovered_at: new Date().toISOString(), verification: 'domain_match' }
        : { provider: 'none', discovered_at: new Date().toISOString(), verification };
      await ctx.supabase.from('entities').update({
        attributes: { ...ent.attributes, ats: newHint },
      }).eq('id', ent.id);
      ent.attributes.ats = newHint;
      if (!provider) { result.skipped++; continue; }
      prefetched = { ok: true, jobs: firstJobs, status: 200 };
    }

    // Fetch jobs from the known provider (or reuse the verified probe response).
    let fetchResult: JobsFetchResult;
    if (prefetched) {
      fetchResult = prefetched;
    } else {
      try {
        fetchResult = await FETCHERS[provider!](slug!);
      } catch (e) {
        result.errors.push(`${ent.name} fetch ${provider} failed: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
    }
    if (!fetchResult.ok) {
      // Provider returned non-200 on a known slug — likely the company removed
      // the board or changed slugs. Clear the hint so next run re-probes.
      await ctx.supabase.from('entities').update({
        attributes: { ...ent.attributes, ats: { provider: 'none', discovered_at: new Date().toISOString() } },
      }).eq('id', ent.id);
      result.skipped++;
      continue;
    }

    // Diff against last-seen job IDs (stored on attributes). New IDs → signals.
    const seenIds = new Set<string>(((ent.attributes.ats_seen_jobs as string[]) ?? []));
    const newJobs = fetchResult.jobs.filter((j) => !seenIds.has(j.external_id));

    for (const job of newJobs) {
      const body = `${ent.name} is hiring: ${job.title}${job.location ? ` (${job.location})` : ''}${job.department ? ` — ${job.department}` : ''}. ${job.url}`;
      const r = await callTool(ctx.supabase, sourceActor, 'create_signal', {
        entity_id: ent.id,
        type: 'hiring_post',
        magnitude: 0.75,    // hiring is a high-intent signal across the board
        body_for_embedding: body,
        structured_tags: {
          signal_source: 'ats',
          // Cross-connector classifier — any future hiring source (LinkedIn,
          // Workable, per-company ATS) sets the same value so a single
          // subscription with structured_filter={kind:'hiring'} catches them all.
          // The match RPC matches against structured_tags (jsonb @>), not the
          // signal.type column.
          kind: 'hiring',
          source_id: ctx.source_id,
          ats_provider: provider,
          ats_slug: slug,
          job_external_id: job.external_id,
          job_title: job.title,
          job_url: job.url,
          job_location: job.location ?? null,
          job_department: job.department ?? null,
          job_posted_at: job.posted_at ?? null,
          attribution_method: 'ats_direct',
        },
      });
      if (r.ok) result.signals_created++;
      else result.errors.push(`create_signal failed for ${ent.name}/${job.title}: ${r.error}`);
    }

    // Update seen set. Cap to recent 200 to keep the attribute compact.
    const allSeen = new Set<string>([...seenIds, ...fetchResult.jobs.map((j) => j.external_id)]);
    const trimmed = [...allSeen].slice(-200);
    await ctx.supabase.from('entities').update({
      attributes: { ...ent.attributes, ats_seen_jobs: trimmed },
    }).eq('id', ent.id);
  }

  return result;
};

export default ats;
