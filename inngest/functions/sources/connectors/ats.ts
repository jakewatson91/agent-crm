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
import { callTool, classifyRole, passesHiringFilter, getPolicy, type HiringFilter } from '@agent-crm/tools';
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
  // Rich fields — populated when the provider returns them. The enricher
  // reads description out of body_for_embedding to produce structured
  // hiring facts (role, tech stack, responsibilities, salary band).
  description?: string | null;
  salary_min?: number | null;
  salary_max?: number | null;
  salary_currency?: string | null;
  salary_period?: string | null;     // 'year' | 'hour' | 'month' | etc.
  employment_type?: string | null;   // 'full_time' | 'contract' | 'intern' | ...
  team?: string | null;
}

interface JobsFetchResult { ok: boolean; jobs: JobPosting[]; status: number }

// Strip HTML to plain text. Job-board HTML is well-formed and shallow; no
// need for a real parser. Replaces block-level closers with newlines so the
// LLM doesn't see one giant run-on paragraph.
function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<\/(p|div|li|h\d|br|tr)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// Per-job detail fetches (Workable) are capped per entity per run so a single
// high-volume board can't blow up the cron.
const MAX_DETAIL_FETCHES_PER_ENTITY = 25;
// How many no-longer-live job ids to retain in the seen-set beyond the
// currently-live ones. Tolerates a role briefly dropping off a board and
// returning without re-emitting it. Bounds the stored attribute size; live ids
// are always kept regardless of this number.
const HISTORY_BUDGET = 500;
// Description truncation before storing on the signal. ~4000 chars is enough
// for the enricher to spot tech stack + responsibilities + salary range
// without bloating the signal row.
const MAX_DESCRIPTION_CHARS = 4000;
const DESCRIPTION_EXCERPT_FOR_EMBEDDING = 1500;

// ---- Per-provider fetchers ----

const FETCH_TIMEOUT_MS = 10_000;

async function fetchGreenhouse(slug: string): Promise<JobsFetchResult> {
  // ?content=true returns the description inline so we don't need a per-job fetch.
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`;
  const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!r.ok) return { ok: false, jobs: [], status: r.status };
  const j = await r.json() as { jobs?: Array<{
    id: number;
    title: string;
    absolute_url: string;
    location?: { name?: string };
    updated_at?: string;
    content?: string;
    departments?: Array<{ name?: string }>;
    pay_input_ranges?: Array<{ min_cents?: number; max_cents?: number; currency_type?: string; interval?: string }>;
  }> };
  const jobs: JobPosting[] = (j.jobs ?? []).map((p) => {
    const pay = p.pay_input_ranges?.[0];
    return {
      external_id: `gh:${p.id}`,
      title: p.title,
      url: p.absolute_url,
      location: p.location?.name ?? null,
      department: p.departments?.[0]?.name ?? null,
      posted_at: p.updated_at ?? null,
      description: p.content ? htmlToText(p.content).slice(0, MAX_DESCRIPTION_CHARS) : null,
      salary_min: pay?.min_cents != null ? Math.round(pay.min_cents / 100) : null,
      salary_max: pay?.max_cents != null ? Math.round(pay.max_cents / 100) : null,
      salary_currency: pay?.currency_type ?? null,
      salary_period: pay?.interval ?? null,
    };
  });
  return { ok: true, jobs, status: 200 };
}

async function fetchLever(slug: string): Promise<JobsFetchResult> {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`;
  const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!r.ok) return { ok: false, jobs: [], status: r.status };
  const arr = await r.json() as Array<{
    id: string;
    text: string;
    hostedUrl: string;
    categories?: { location?: string; team?: string; department?: string; commitment?: string };
    createdAt?: number;
    descriptionPlain?: string;
    description?: string;
    salaryRange?: { min?: number; max?: number; currency?: string; interval?: string };
  }>;
  const jobs: JobPosting[] = arr.map((p) => {
    const descPlain = p.descriptionPlain ?? (p.description ? htmlToText(p.description) : null);
    return {
      external_id: `lv:${p.id}`,
      title: p.text,
      url: p.hostedUrl,
      location: p.categories?.location ?? null,
      department: p.categories?.department ?? p.categories?.team ?? null,
      team: p.categories?.team ?? null,
      employment_type: p.categories?.commitment ?? null,
      posted_at: p.createdAt ? new Date(p.createdAt).toISOString() : null,
      description: descPlain ? descPlain.slice(0, MAX_DESCRIPTION_CHARS) : null,
      salary_min: p.salaryRange?.min ?? null,
      salary_max: p.salaryRange?.max ?? null,
      salary_currency: p.salaryRange?.currency ?? null,
      salary_period: p.salaryRange?.interval ?? null,
    };
  });
  return { ok: true, jobs, status: 200 };
}

async function fetchAshby(slug: string): Promise<JobsFetchResult> {
  // includeCompensation=true asks Ashby to include comp on roles that opt in to display it.
  const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`;
  const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!r.ok) return { ok: false, jobs: [], status: r.status };
  const j = await r.json() as { jobs?: Array<{
    id: string;
    title: string;
    jobUrl: string;
    locationName?: string;
    departmentName?: string;
    teamName?: string;
    employmentType?: string;
    publishedAt?: string;
    descriptionPlain?: string;
    descriptionHtml?: string;
    compensation?: {
      compensationTierSummary?: string;
      summaryComponents?: Array<{ minValue?: number; maxValue?: number; currencyCode?: string; interval?: string }>;
    };
  }> };
  const jobs: JobPosting[] = (j.jobs ?? []).map((p) => {
    const descPlain = p.descriptionPlain ?? (p.descriptionHtml ? htmlToText(p.descriptionHtml) : null);
    const comp = p.compensation?.summaryComponents?.[0];
    return {
      external_id: `ah:${p.id}`,
      title: p.title,
      url: p.jobUrl,
      location: p.locationName ?? null,
      department: p.departmentName ?? null,
      team: p.teamName ?? null,
      employment_type: p.employmentType ?? null,
      posted_at: p.publishedAt ?? null,
      description: descPlain ? descPlain.slice(0, MAX_DESCRIPTION_CHARS) : null,
      salary_min: comp?.minValue ?? null,
      salary_max: comp?.maxValue ?? null,
      salary_currency: comp?.currencyCode ?? null,
      salary_period: comp?.interval ?? null,
    };
  });
  return { ok: true, jobs, status: 200 };
}

async function fetchWorkable(slug: string): Promise<JobsFetchResult> {
  // List endpoint has no description — only metadata. The description requires
  // a per-job detail fetch (done lazily for NEW jobs only, capped per run).
  const url = `https://apply.workable.com/api/v3/accounts/${encodeURIComponent(slug)}/jobs`;
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: '' }), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!r.ok) return { ok: false, jobs: [], status: r.status };
  const j = await r.json() as { results?: Array<{ id: string; title: string; shortcode?: string; locations?: Array<{ location_str?: string }>; department?: string; published_on?: string; employment_type?: string }> };
  const jobs: JobPosting[] = (j.results ?? []).map((p) => ({
    external_id: `wk:${p.id}`,
    title: p.title,
    url: `https://apply.workable.com/${encodeURIComponent(slug)}/j/${p.shortcode ?? p.id}/`,
    location: p.locations?.[0]?.location_str ?? null,
    department: p.department ?? null,
    employment_type: p.employment_type ?? null,
    posted_at: p.published_on ?? null,
    // shortcode is what the detail endpoint keys off — stash it on team for now
    // so the per-job fetch can find it (consumed and cleared below).
    team: p.shortcode ?? null,
  }));
  return { ok: true, jobs, status: 200 };
}

// Workable per-job detail fetch — only called for NEW postings (the seen-jobs
// diff already filtered most away), capped to MAX_DETAIL_FETCHES_PER_ENTITY.
async function enrichWorkableJob(slug: string, shortcode: string): Promise<{
  description?: string | null;
  salary_min?: number | null;
  salary_max?: number | null;
  salary_currency?: string | null;
  salary_period?: string | null;
}> {
  try {
    const url = `https://apply.workable.com/api/v3/accounts/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(shortcode)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!r.ok) return {};
    const j = await r.json() as {
      description?: string;
      requirements?: string;
      benefits?: string;
      salary?: { salary_from?: number; salary_to?: number; salary_currency?: string };
    };
    const combined = [j.description, j.requirements, j.benefits].filter(Boolean).join('\n\n');
    return {
      description: combined ? htmlToText(combined).slice(0, MAX_DESCRIPTION_CHARS) : null,
      salary_min: j.salary?.salary_from ?? null,
      salary_max: j.salary?.salary_to ?? null,
      salary_currency: j.salary?.salary_currency ?? null,
      salary_period: 'year',
    };
  } catch {
    return {};
  }
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
      const r = await fetch(url, { headers: { 'User-Agent': 'agent-crm-ats-discovery/1.0' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
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
  // Optional per-company ceiling on new hiring signals emitted in one run. Undefined
  // = no cap (vertical-neutral default). When set, only the freshest N postings
  // become signals; the rest are still marked seen so they aren't re-emitted later.
  const max_new_signals_per_entity = ctx.config.max_new_signals_per_entity as number | undefined;

  // Load active accounts + their full entity rows (need attributes for the
  // ATS hint cache).
  const watch = await getWatchedAccounts(ctx.supabase, ctx.workspace_id);
  if (!watch.length) return result;
  const watchIds = watch.map((w) => w.entity_id);

  // Workspace hiring filter — empty/missing = include all (preserves prior behavior).
  const policy = await getPolicy(ctx.supabase, ctx.workspace_id);
  // policy.hiring_filter is the loose config shape (string[] families); passesHiringFilter
  // only does membership checks, so the strict HiringFilter type is satisfied at runtime.
  const hiringFilter = (policy.hiring_filter ?? null) as HiringFilter | null;

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
      // Generic watch-target flag the archive sweep reads (see system_tasks.ts).
      // True once we adopt a real board to re-poll; false when this entity has no
      // board, so the sweep can reclaim it after the age cutoff.
      const watched = newHint.provider !== 'none';
      await ctx.supabase.from('entities').update({
        attributes: { ...ent.attributes, ats: newHint, _watched_by_source: watched },
      }).eq('id', ent.id);
      ent.attributes.ats = newHint;
      ent.attributes._watched_by_source = watched;
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
        attributes: { ...ent.attributes, ats: { provider: 'none', discovered_at: new Date().toISOString() }, _watched_by_source: false },
      }).eq('id', ent.id);
      result.skipped++;
      continue;
    }

    // Diff against last-seen job IDs (stored on attributes). New IDs → candidates.
    const seenIds = new Set<string>(((ent.attributes.ats_seen_jobs as string[]) ?? []));
    const newJobs = fetchResult.jobs.filter((j) => !seenIds.has(j.external_id));
    // Freshest first so an optional per-entity cap keeps the most recent roles.
    // Missing posted_at sorts last (Date.parse('') → NaN → 0).
    newJobs.sort((a, b) => ((Date.parse(b.posted_at ?? '') || 0) - (Date.parse(a.posted_at ?? '') || 0)));

    let detailFetches = 0;
    let emitted = 0;
    for (const job of newJobs) {
      // Per-entity cap: once we've emitted N new signals this run, stop. Remaining
      // new jobs are still marked seen below, so they won't re-emit next run.
      if (max_new_signals_per_entity != null && emitted >= max_new_signals_per_entity) break;
      // 1. Workable per-job detail fetch (capped). The list endpoint doesn't
      //    include description / salary; without these the classifier still
      //    works on title alone, but the enricher loses most of its signal.
      if (provider === 'workable' && job.team && detailFetches < MAX_DETAIL_FETCHES_PER_ENTITY) {
        const detail = await enrichWorkableJob(slug!, job.team);
        job.description = detail.description ?? job.description ?? null;
        job.salary_min = detail.salary_min ?? job.salary_min ?? null;
        job.salary_max = detail.salary_max ?? job.salary_max ?? null;
        job.salary_currency = detail.salary_currency ?? job.salary_currency ?? null;
        job.salary_period = detail.salary_period ?? job.salary_period ?? null;
        job.team = null;    // we stashed shortcode here; clear it
        detailFetches += 1;
      }

      // 2. Classify the role. Cached deploy-wide by title hash — first-ever sighting
      //    of a title costs one LLM call; every subsequent workspace+entity is free.
      const classification = await classifyRole(ctx.supabase, ctx.workspace_id, job.title, job.department);

      // 3. Filter. Postings that don't match the workspace filter are dropped
      //    here — no signal, no enrichment. We still mark them as seen so we
      //    don't re-classify the same posting next run.
      if (!passesHiringFilter(classification, hiringFilter)) {
        result.skipped++;
        continue;
      }

      // 4. Build the signal body. The old one-line body gave the enricher
      //    nothing to chew on; the description excerpt is what lets it produce
      //    role, tech stack, responsibilities, and salary facts.
      const headline = `${ent.name} is hiring: ${job.title}${job.location ? ` (${job.location})` : ''}${job.department ? ` — ${job.department}` : ''}.`;
      const roleLine = `Role: ${classification.family} / ${classification.seniority}${classification.is_exec ? ' (exec)' : ''}.`;
      const descExcerpt = (job.description ?? '').slice(0, DESCRIPTION_EXCERPT_FOR_EMBEDDING);
      const body = [headline, roleLine, descExcerpt, job.url].filter(Boolean).join('\n');

      const r = await callTool(ctx.supabase, sourceActor, 'create_signal', {
        entity_id: ent.id,
        type: 'hiring_post',
        magnitude: 0.75,    // hiring is a high-intent signal across the board
        body_for_embedding: body,
        // Idempotency: one job posting = one signal. If this role was already
        // emitted for this entity (even after the seen-set cache rolled it out),
        // create_signal no-ops instead of writing a duplicate + embedding.
        dedup_key: job.external_id,
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
          job_team: job.team ?? null,
          job_posted_at: job.posted_at ?? null,
          job_description: job.description ?? null,
          job_employment_type: job.employment_type ?? null,
          job_salary_min: job.salary_min ?? null,
          job_salary_max: job.salary_max ?? null,
          job_salary_currency: job.salary_currency ?? null,
          job_salary_period: job.salary_period ?? null,
          role_family: classification.family,
          role_seniority: classification.seniority,
          role_is_exec: classification.is_exec,
          role_filter_passed: true,
          attribution_method: 'ats_direct',
        },
      });
      // Count only genuinely new signals toward the cap + metrics. A dedup hit
      // (r.deduped) means the row already existed — not new work.
      if (r.ok && !r.deduped) { result.signals_created++; emitted++; }
      else if (!r.ok) result.errors.push(`create_signal failed for ${ent.name}/${job.title}: ${r.error}`);
    }

    // Update seen set with EVERY current job ID (passed-filter or not), so
    // filtered-out postings don't get re-classified on the next run.
    //
    // CRITICAL: keep every currently-live job id. The old `slice(-200)` trimmed
    // the set to 200 even when the board had more open roles, so boards with
    // >200 jobs (SpaceX, Stripe, ...) forgot their overflow each run and
    // re-emitted it as "new." Live ids are never dropped; only ids that have
    // fallen off the board age out, bounded by HISTORY_BUDGET for flicker (a
    // role that briefly disappears then returns).
    const liveSet = new Set<string>(fetchResult.jobs.map((j) => j.external_id));
    const historical = [...seenIds].filter((id) => !liveSet.has(id));
    const trimmed = [...liveSet, ...historical.slice(-HISTORY_BUDGET)];
    await ctx.supabase.from('entities').update({
      attributes: { ...ent.attributes, ats_seen_jobs: trimmed },
    }).eq('id', ent.id);
  }

  return result;
};

export default ats;
