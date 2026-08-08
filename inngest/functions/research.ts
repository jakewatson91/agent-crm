/**
 * Deep-research handler. Triggered by the action_selector (reactive) or the
 * entity_research_dispatcher (proactive, score-tiered) for an entity that merits a
 * web pull.
 *
 * Instead of one bare name search, it runs the workspace's AI-planned research
 * strategy — a small set of search angles (own-site posts, news, customers, ...) the
 * planner authored from the workspace's own description (see research_strategy.ts).
 * Each angle is one Exa search scoped to this entity; results become `research_result`
 * signals tagged with the angle id so we can later tell which angles actually move a
 * score.
 *
 * Budget: the dispatcher decides how many angles to run for this entity (`angle_count`)
 * by tier, against the workspace's per-run Exa budget. Concurrency-limited per workspace.
 */
import { createServerClient } from '@agent-crm/db';
import {
  callTool, recordActivityMarker, latestMarkerAt, ACTIVITY_MARKERS,
  getPolicy, resolveEnvVar, resolveStrategy, resolveContactStrategy, runExaSearch, filterResultsByEntity, fetchEntityGrounding, pageMentionsEntity, readEntityAliases,
  dedupeResearchCandidates, DUP_LOOKBACK_DAYS, researchSignalMagnitude,
  DEFAULT_MAX_AGE_DAYS, DEFAULT_DECAY_HALF_LIFE_DAYS, DEFAULT_CONTACT_MAX_AGE_DAYS, HOOK_CLASS_WEIGHT,
  resolveDomainViaSearch, resolveAliasesViaSearch, getPipelineStatus, setPipelineStatus,
} from '@agent-crm/tools';
import type { ResearchAngle, ExaResult } from '@agent-crm/tools';
import { isPersistentWall } from './advance_accounts.js';
import { inngest } from '../client.js';

const SEEN_WINDOW_DAYS = 30;
// The freshness defaults, the hook-class weights and the magnitude formula all
// moved to packages/tools/src/scoring.ts. The enricher applies the same floor
// once it reads the page and finds the real dateline, and two copies of these
// numbers would drift apart the first time one of them was tuned.

/** Normalize a URL for exact same-source collapse: drop protocol, www, query, trailing slash. */
function normalizeUrl(u: string): string {
  try {
    const url = new URL(u);
    return `${url.hostname.replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return u.trim().toLowerCase();
  }
}
/**
 * Is this URL on the entity's own domain (or a subdomain of it)? Same host test
 * the relevance gate uses to auto-confirm identity, so the name gate below
 * exempts exactly the pages the gate would have trusted anyway.
 */
function isOwnDomain(u: string, domain: string): boolean {
  if (!domain) return false;
  try {
    const host = new URL(u).hostname.replace(/^www\./, '').toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

// A failed domain resolution cools the entity down this long before another
// search is spent on it (the name simply may not resolve to a safe host).
const RESOLVE_RETRY_DAYS = 30;

/**
 * Pull a few descriptive keywords from the entity's facts — only used by angles whose
 * template references {keywords}. Mirrors the old runner's filter: stack/customer/
 * vertical-ish facts, no scores/flags/dates.
 */
async function entityKeywords(
  supabase: ReturnType<typeof createServerClient>,
  workspace_id: string,
  entity_id: string,
): Promise<string> {
  const facts = await supabase
    .from('facts')
    .select('predicate, object_text')
    .eq('workspace_id', workspace_id)
    .eq('subject_entity', entity_id)
    .is('supersedes', null)
    .limit(20);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of (facts.data ?? []) as Array<{ predicate: string; object_text: string | null }>) {
    const val = f.object_text?.trim();
    if (!val) continue;
    if (/^score_/.test(f.predicate) || /_breakdown$/.test(f.predicate)) continue;
    if (!/stack|uses|integrat|customer|target|industry|vertical/.test(f.predicate)) continue;
    if (/^[\d.]+$/.test(val) || /^(true|false|yes|no)$/i.test(val) || /^\d{4}-\d{2}-\d{2}/.test(val)) continue;
    if (val.length < 3) continue;
    const k = val.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(val);
  }
  return out.slice(0, 3).join(' ');
}

/**
 * Short grounding blurb used to disambiguate same-name companies: the company's own
 * homepage/blog snippets (strongest) plus any descriptive facts we already hold.
 */
async function entityContext(
  supabase: ReturnType<typeof createServerClient>,
  workspace_id: string,
  entity_id: string,
  ownSiteSnippets: string[],
): Promise<string> {
  const facts = await supabase
    .from('facts')
    .select('predicate, object_text')
    .eq('workspace_id', workspace_id)
    .eq('subject_entity', entity_id)
    .is('supersedes', null)
    .limit(40);
  const desc: string[] = [];
  for (const f of (facts.data ?? []) as Array<{ predicate: string; object_text: string | null }>) {
    if (/^score_/.test(f.predicate) || /_breakdown$/.test(f.predicate)) continue;
    if (!/desc|industr|sector|product|offer|what|target|customer|vertical|categor|summary|tagline|business|market|does/.test(f.predicate)) continue;
    const v = f.object_text?.trim();
    if (!v || v.length < 3) continue;
    desc.push(`${f.predicate}: ${v}`);
    if (desc.length >= 6) break;
  }
  return [ownSiteSnippets.slice(0, 2).join(' | '), desc.join('; ')].filter(Boolean).join(' || ').slice(0, 600);
}

/** Turn one angle into an Exa request for this entity. Returns null if unrunnable. */
export function buildAngleRequest(
  angle: ResearchAngle,
  entity_name: string,
  domain: string,
  keywords: string,
  social_domains: string[],
  // The linked account's name, for a contact-kind angle's {company} token.
  // Unused (and harmless to omit) for account-kind angles.
  company?: string,
  // The workspace's ingestion floor (policy.research.max_age_days). An angle
  // asking Exa for a wider window than the floor is buying results the gate
  // below will bin: Sudden's peak-viewers angle asked for 365 days against a
  // 90-day floor, so everything from 91 to 365 days old was fetched, paid for
  // and dropped. Two of its five angles had this shape, i.e. 40% of the search
  // budget on that account could not survive ingestion no matter what it found.
  // Omit to keep the angle's own window (the checks call it that way).
  maxAgeDays?: number,
  // Hosts to keep out of the name-searched angles (policy.research.exclude_domains).
  // Content farms republish an article under their own timestamp, which makes a
  // years-old story look like this week's news to every date check we run, and
  // there was previously no way to keep a known one out short of a code change.
  // Only reaches `news` and `open_web`: the other two scopes already send an
  // include list, so nothing is there to exclude.
  excludeDomains: string[] = [],
): { query: string; params: Parameters<typeof runExaSearch>[1] } | null {
  const query = angle.query_template
    .replaceAll('{entity}', entity_name)
    .replaceAll('{domain}', domain)
    .replaceAll('{keywords}', keywords)
    .replaceAll('{company}', company ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  if (!query) return null;

  // Never ask for a window the ingestion floor will reject. An angle that sets
  // NO window is left alone on purpose: that is the deliberately evergreen case
  // (a customer or case-study list), where the value is undated pages, and
  // undated pages are exempt from the floor. Clamping there would exclude the
  // only results that angle exists to find.
  const windowDays = angle.recency_days && maxAgeDays
    ? Math.min(angle.recency_days, maxAgeDays)
    : angle.recency_days;
  const start_published_date = windowDays
    ? new Date(Date.now() - windowDays * 86400 * 1000).toISOString()
    : undefined;
  const num_results = angle.num_results ?? 10;

  if (angle.domain_scope === 'own_site') {
    if (!domain) return null; // can't scope to a site we don't know
    // Only filter at query time when the angle set recency_days (a "recent
    // posts/launches" angle should); an angle that omits it is deliberately
    // evergreen (a customer/case-study list). Either way the post-fetch age
    // gate still holds: a dated result past the freshness floor is dropped
    // regardless of scope, so an evergreen angle can't smuggle in an old
    // dated post just because no start_published_date was sent here.
    return { query, params: { query, num_results, include_domains: [domain], start_published_date } };
  }
  const exclude_domains = excludeDomains.filter(Boolean);
  if (angle.domain_scope === 'news') {
    return { query, params: { query, num_results, category: 'news', start_published_date, include_text: [entity_name], exclude_domains } };
  }
  if (angle.domain_scope === 'social') {
    // Exec posts/talks/interviews on the workspace-configured social hosts.
    // Searched by name, so results are NOT trusted — they go through the same
    // disambiguation gate as news/open_web (name collisions are worst here).
    if (!social_domains.length) return null; // scope not configured
    return { query, params: { query, num_results, start_published_date, include_domains: social_domains, include_text: [entity_name] } };
  }
  // open_web
  return { query, params: { query, num_results, start_published_date, include_text: [entity_name], exclude_domains } };
}

export const researchRunner = inngest.createFunction(
  {
    id: 'research-runner',
    concurrency: { limit: 1, key: 'event.data.workspace_id' },
  },
  { event: 'research.requested' },
  async ({ event, step }) =>
    step.run('search-and-attribute', async () => runEntityResearch(createServerClient(), event.data)),
);

export interface EntityResearchParams {
  workspace_id: string;
  entity_id: string;
  entity_name: string;
  reason: string;
  angle_count?: number;
  // 'contact': entity_id names a person, not a company — searches what THEY
  // have said publicly, scoped to their linked account for context. Default
  // 'account' keeps every existing dispatch (and every prior behavior) unchanged.
  kind?: 'account' | 'contact';
}

/**
 * Core of the research runner — exported so it can be invoked directly (scripts /
 * tests / a local loop) as well as from the Inngest handler above.
 */
export async function runEntityResearch(
  supabase: ReturnType<typeof createServerClient>,
  params: EntityResearchParams,
) {
  const { workspace_id, entity_id, entity_name, reason, angle_count, kind = 'account' } = params;
  {
    {
      const actor = { workspace_id, actor_kind: 'agent' as const, actor_id: 'research_runner' };

      // A standing research pause (Exa credit/auth wall) means every search this
      // run makes would fail identically — don't burn the tick or spam error
      // markers. The operator clears it with Continue after fixing the provider.
      const pipeStatus = await getPipelineStatus(supabase, workspace_id);
      if (pipeStatus?.state === 'paused' && (pipeStatus.scope ?? 'all') !== 'contacts') {
        return { ok: false, reason: `research paused: ${pipeStatus.reason ?? 'pipeline paused'}` };
      }

      const policy = await getPolicy(supabase, workspace_id);
      const apiKey = resolveEnvVar(policy, 'EXA_API_KEY');
      if (!apiKey) return { ok: false, reason: 'EXA_API_KEY not set' };

      // What this workspace sells, for the relevance test in the disambiguation
      // check. signal_type lives on workspaces.icp; pain/guidance on policy. All
      // optional — an unconfigured workspace passes empty arrays and the check
      // degrades to identity + substance only (no over-filtering a fresh import).
      const wsRow = await supabase.from('workspaces').select('icp').eq('id', workspace_id).maybeSingle();
      const icpSignalTypes = (() => {
        const st = (wsRow.data?.icp as { signal_type?: unknown } | null)?.signal_type;
        return Array.isArray(st) ? st.filter((s): s is string => typeof s === 'string') : [];
      })();
      // policy.research.guidance is deliberately NOT passed here. It is planner
      // input — "what should the agent dig up about prospects?", folded into the
      // prompt that WRITES the search queries (see ResearchPolicy in policy.ts).
      // It is phrased as a priority ("the best trigger is an exec interview about
      // delivery costs... prioritize finding that"), and a priority is not a
      // threshold. Feeding it to the relevance gate turned "rank this first" into
      // "reject everything else": on Sudden the gate went from accepting 252
      // results on 07-22 to dropping 89% of them (149 filtered, 18 kept) on 07-28,
      // because almost no page is an executive interview about CDN spend.
      //
      // What the seller cares about is already carried by pains + signal_types,
      // which describe the problem area rather than the ideal single result.
      const relevance = {
        pains: (policy.drafter?.pain_points ?? []).filter(Boolean),
        signal_types: icpSignalTypes,
      };

      // Entity domain drives the own_site angle + collision guards. A contact
      // has no domain of its own — resolve the linked account instead across
      // the works_at edge, so its domain scopes the search and its name/role
      // ground the identity check below. Never duplicated data, just a read
      // one hop over.
      let domain = '';
      let contactAccountName = '';
      let contactRole = '';
      // Other names this company is written under. Needed when the press never
      // uses the registered name — Crazy Maple Studio is only ever covered as
      // "ReelShort" — so the name gate below would otherwise drop every genuine
      // article about it. Entity data, so a new account is fixed by editing the
      // record rather than shipping code.
      let aliases: string[] = [];
      if (kind === 'contact') {
        const worksAt = await supabase.from('facts').select('object_entity')
          .eq('workspace_id', workspace_id).eq('subject_entity', entity_id)
          .eq('predicate', 'works_at').is('supersedes', null).limit(1).maybeSingle();
        const accountId = worksAt.data?.object_entity as string | undefined;
        if (accountId) {
          const [acct, roleF] = await Promise.all([
            supabase.from('entities').select('name, attributes').eq('id', accountId).maybeSingle(),
            supabase.from('facts').select('object_text').eq('workspace_id', workspace_id)
              .eq('subject_entity', entity_id).eq('predicate', 'role').is('supersedes', null).limit(1).maybeSingle(),
          ]);
          contactAccountName = (acct.data?.name as string) ?? '';
          domain = ((acct.data?.attributes as { domain?: string } | null)?.domain ?? '').trim().toLowerCase();
          // A contact's searches run against the employer's domain, so they hit
          // the same gate the account does and need the same alias list. Without
          // this, a Crazy Maple Studio exec's coverage under "ReelShort" is
          // dropped even after the account itself is fixed.
          aliases = readEntityAliases(acct.data?.attributes);
          contactRole = (roleF.data?.object_text as string) ?? '';
        }
        if (!contactAccountName) {
          await recordActivityMarker(supabase, actor, ACTIVITY_MARKERS.RESEARCH_ERROR, entity_id, {
            message: 'contact has no linked account',
            summary: 'research produced no searches',
          });
          return { ok: false, reason: 'no linked account' };
        }
      } else {
        const ent = await supabase.from('entities').select('attributes').eq('id', entity_id).maybeSingle();
        const attrs = ent.data?.attributes as { domain?: string; aliases?: unknown } | null;
        domain = (attrs?.domain ?? '').trim().toLowerCase();
        aliases = readEntityAliases(attrs);
      }

      let searches = 0;
      const errors: string[] = [];

      // No domain blocks the own_site angle (the highest-trust one), the ATS
      // hiring probe, and contact pulls. Spend the first budgeted search on
      // resolving it: one "official website" lookup behind the name-match +
      // corroboration guard in resolveDomainViaSearch. Policy knob
      // research.resolve_domains, default on. A failed attempt writes a marker
      // that cools this entity down so cold ticks don't re-burn their single
      // search on the same unresolvable name; a transport/credit error writes
      // no marker and is counted with the angle errors below so the existing
      // pause-on-credit-wall logic still sees a fully-failed run.
      let resolver_spent = 0;
      if (kind === 'account' && !domain && policy.research?.resolve_domains !== false) {
        const failedAt = await latestMarkerAt(supabase, workspace_id, entity_id, [ACTIVITY_MARKERS.DOMAIN_RESOLVE_FAILED]);
        const coolingDown = !!failedAt && Date.now() - Date.parse(failedAt) < RESOLVE_RETRY_DAYS * 86400 * 1000;
        if (!coolingDown) {
          resolver_spent = 1;
          searches++;
          const resolved = await resolveDomainViaSearch(supabase, { workspace_id, entity_id, entity_name, exa_api_key: apiKey });
          if (resolved.status === 'resolved' && resolved.domain) domain = resolved.domain;
          else if (resolved.status === 'search_error') errors.push(`domain_resolve: ${resolved.error ?? 'Exa error'}`);
        }
      }

      // Aliases: the other names this account's coverage is published under.
      // Runs after the domain resolver because it reads the company's OWN site,
      // so an account that just got a domain can be read in the same tick. Costs
      // one search, spent from the same budget, and only ever once per account —
      // a success stores the names, a failure writes a marker that cools the
      // account down for RESOLVE_RETRY_DAYS.
      //
      // This is what stops the gate below from dropping every real article about
      // a company the press calls by its product name.
      if (kind === 'account' && domain && !aliases.length && policy.research?.resolve_aliases !== false) {
        const failedAt = await latestMarkerAt(supabase, workspace_id, entity_id, [ACTIVITY_MARKERS.ALIASES_RESOLVE_FAILED]);
        const coolingDown = !!failedAt && Date.now() - Date.parse(failedAt) < RESOLVE_RETRY_DAYS * 86400 * 1000;
        if (!coolingDown) {
          resolver_spent += 1;
          searches++;
          const resolvedAliases = await resolveAliasesViaSearch(supabase, { workspace_id, entity_id, entity_name, exa_api_key: apiKey });
          if (resolvedAliases.status === 'resolved') aliases = resolvedAliases.aliases;
          else if (resolvedAliases.status === 'search_error') errors.push(`alias_resolve: ${resolvedAliases.error ?? 'Exa error'}`);
        }
      }

      // The strategy is generated + cached by the dispatcher; the runner only
      // reads it. Slice the per-account angle budget from the angles that can
      // actually run for THIS entity: own_site needs a domain (one resolved
      // just above counts, so hot accounts get own-site results in the same
      // tick), and a positional slice handed domainless accounts (most of a
      // fresh CSV import) an own_site-only list, so they burned a dispatch
      // slot on zero searches. The resolver's search spends from the same
      // budget: a cold pick with angle_count=1 uses its tick on resolution
      // and researches on the next pick, which is fine and self-healing.
      // Freshness controls (policy override, else defaults). Applies to every
      // scope, including own_site — only an undated result is exempt (see gate
      // below); a dated own-site post is bound by the same floor as news.
      // Computed here (not just below) because a contact-kind strategy needs
      // it to set the query-time recency filter on its angles.
      const maxAgeDays = kind === 'contact'
        ? (policy.research?.contact_signal_max_age_days ?? DEFAULT_CONTACT_MAX_AGE_DAYS)
        : (policy.research?.max_age_days ?? DEFAULT_MAX_AGE_DAYS);
      const halfLifeDays = policy.research?.decay_half_life_days ?? DEFAULT_DECAY_HALF_LIFE_DAYS;

      const socialDomains = (policy.research?.social_domains ?? []).filter(Boolean);
      const excludeDomains = (policy.research?.exclude_domains ?? []).filter(Boolean);
      const allAngles = kind === 'contact' ? resolveContactStrategy(maxAgeDays) : resolveStrategy(policy);
      const runnable = allAngles.filter((a) =>
        (a.domain_scope !== 'own_site' || !!domain) &&
        (a.domain_scope !== 'social' || socialDomains.length > 0));
      const toRun = typeof angle_count === 'number' && angle_count > 0
        ? runnable.slice(0, Math.max(angle_count - resolver_spent, 0))
        : runnable;
      if (!toRun.length && !resolver_spent) {
        // Same marker the zero-search path writes: without it the dispatcher
        // sees an unresearched account and re-picks it every tick. When the
        // resolver spent the budget this is skipped: the run did real work and
        // the RESEARCH_COMPLETED marker below records it.
        await recordActivityMarker(supabase, actor, ACTIVITY_MARKERS.RESEARCH_ERROR, entity_id, {
          message: 'no runnable angles (missing domain / empty templates)',
          summary: 'research produced no searches',
        });
        return { ok: false, reason: 'no runnable angles' };
      }
      const keywords = toRun.some((a) => a.query_template.includes('{keywords}'))
        ? await entityKeywords(supabase, workspace_id, entity_id)
        : '';

      // Cross-run dedup: collect Exa result ids already seen for this entity.
      const since = new Date(Date.now() - SEEN_WINDOW_DAYS * 86400 * 1000).toISOString();
      const seenRes = await supabase
        .from('signals')
        .select('structured_tags')
        .eq('workspace_id', workspace_id)
        .eq('entity_id', entity_id)
        .gte('observed_at', since);
      const seenIds = new Set<string>();
      for (const s of (seenRes.data ?? []) as Array<{ structured_tags: { exa_id?: string } | null }>) {
        const id = s.structured_tags?.exa_id;
        if (id) seenIds.add(id);
      }

      // maxAgeDays/halfLifeDays computed above (kind-aware, needed earlier by
      // the strategy resolver too).
      const staleCutoffMs = Date.now() - maxAgeDays * 86400 * 1000;

      // --- Fetch phase: collect candidates, separating own-site (collision-proof,
      // domain-scoped) from news/open_web (searched by name -> must be disambiguated). ---
      interface Candidate { angleId: string; scope: ResearchAngle['domain_scope']; er: ExaResult }
      const candidates: Candidate[] = [];
      const ownSiteSnippets: string[] = [];
      let filtered_stale = 0;
      // Off-company pages Exa returned despite includeText, killed before the
      // LLM gate ever sees them. Counted apart from filtered_out so a collapse
      // in yield can be read as "the searches came back wrong" rather than
      // "the gate got stricter" — those need opposite fixes.
      let filtered_no_name = 0;
      for (const angle of toRun) {
        const built = buildAngleRequest(angle, entity_name, domain, keywords, socialDomains, kind === 'contact' ? contactAccountName : undefined, maxAgeDays, excludeDomains);
        if (!built) continue;
        searches++;
        const res = await runExaSearch(apiKey, built.params);
        if (!res.ok) {
          errors.push(`${angle.id}: Exa ${res.status ?? ''} ${res.error ?? ''}`.trim());
          continue;
        }
        for (const er of res.results) {
          if (!er.id || seenIds.has(er.id)) continue;
          // Age gate: drop a result whose source is older than the floor (a
          // 2021 launch announcement is not an outreach hook, even from the
          // company's own blog). A missing or unparseable date is kept —
          // undated evergreen pages (own-site customer lists, product pages)
          // are legitimate regardless of scope.
          //
          // The date read here is already corrected against the URL by
          // runExaSearch. Do not go back to Exa's raw publishedDate: it reports
          // the crawl date for pages it cannot date, which walked a March 2022
          // post through this gate as of yesterday. See published_date.ts.
          if (er.publishedDate) {
            const pub = Date.parse(er.publishedDate);
            if (Number.isFinite(pub) && pub < staleCutoffMs) { filtered_stale++; continue; }
          }
          // Name gate: Exa only honours `includeText` on keyword routes, so a
          // neural/auto search for a small brand plus topic words returns the
          // best pages about the TOPIC — "Weyyak concurrent viewers" came back
          // as Naver Chzzk and UFC ratings. Those cannot become signals, but
          // without this they still cost an LLM judgement each. Own-domain
          // pages are exempt: the host already proves identity, and a company's
          // own page need not repeat its name in the crawled excerpt.
          if (!isOwnDomain(er.url, domain) && !pageMentionsEntity(entity_name, domain, er, aliases)) {
            filtered_no_name++;
            continue;
          }
          seenIds.add(er.id); // dedup within this run too
          candidates.push({ angleId: angle.id, scope: angle.domain_scope, er });
          if (angle.domain_scope === 'own_site') {
            const snip = [er.title, (er.text ?? '').slice(0, 200)].filter(Boolean).join(' — ');
            if (snip) ownSiteSnippets.push(snip);
          }
        }
      }

      // --- Relevance phase: identity + substance + (when the workspace configured what it
      // sells) relevance, in one check. Own-site results have identity auto-confirmed inside
      // by the host match; with no relevance config they're accepted outright (unchanged),
      // with relevance config they still must clear the relevance bar. This is the fix for
      // the NHL/VAST case: that off-topic storage press came from the company's OWN newsroom
      // (own_site scope), which the old "trust own-site" path never relevance-checked. ---
      const allForGate = candidates.map((c) => ({ id: c.er.id, title: c.er.title, url: c.er.url, text: c.er.text }));
      let filtered_out = 0;
      // Which of the gate's three tests did the drops fail. This gate discards
      // most of what research finds, so when yield moves the first question is
      // always "which condition changed" — recording only a total meant that
      // took config archaeology instead of one query.
      let filtered_by = { identity: 0, substance: 0, relevance: 0, unreported: 0 };
      const acceptedIds = new Set<string>();
      let hookClassById = new Map<string, 'event' | 'direction' | 'profile'>();
      if (allForGate.length) {
        // Ground the disambiguation in the company's own words. Reuse own-site snippets
        // when we have them; otherwise fetch the homepage so a thin, common-named entity
        // (no facts, own-site not indexed) still anchors to the right company.
        let grounding = ownSiteSnippets.slice(0, 2).join(' | ');
        if (!grounding && domain) grounding = await fetchEntityGrounding(apiKey, entity_name, domain);
        const factsContext = await entityContext(supabase, workspace_id, entity_id, grounding ? [grounding] : []);
        // A contact's own facts (role/email/seed data) rarely carry the
        // descriptive predicates entityContext looks for, so lead with the
        // one line that actually disambiguates a person: their role and
        // company. factsContext still rides along — a prior research pass may
        // have already put something useful on this contact.
        const context = kind === 'contact'
          ? [`${contactRole ? `${contactRole} at` : 'Works at'} ${contactAccountName}.`, factsContext].filter(Boolean).join(' || ').slice(0, 600)
          : factsContext;
        const rel = await filterResultsByEntity({ name: entity_name, domain, context, relevance }, allForGate);
        for (const id of rel.accepted) acceptedIds.add(id);
        hookClassById = rel.classById;
        filtered_out = rel.dropped;
        filtered_by = rel.droppedBy;
      }

      // --- Dedup phase: collapse near-identical accepted results (two articles on the
      // same event) and anything that restates a research signal already on the entity,
      // by embedding cosine — BEFORE any signal is created, so the enricher never runs
      // twice on the same story and no duplicate facts land. Own-site first = highest
      // trust kept when a same-event own page and a news page collide. ---
      // Exact same-URL collapse first (deterministic, free): Exa can surface one
      // page under two ids via two angles, and the embedding dedup below can miss
      // it when the two excerpts differ. Keep the own_site-first one.
      const seenUrls = new Set<string>();
      let same_url_dropped = 0;
      const acceptedOrdered = candidates
        .filter((c) => acceptedIds.has(c.er.id))
        .sort((a, b) => (a.scope === 'own_site' ? 0 : 1) - (b.scope === 'own_site' ? 0 : 1))
        .filter((c) => {
          const key = normalizeUrl(c.er.url);
          if (seenUrls.has(key)) { same_url_dropped++; return false; }
          seenUrls.add(key);
          return true;
        })
        .map((c) => ({ id: c.er.id, body: [c.er.title, c.er.text].filter(Boolean).join('\n') }));
      const dupSince = new Date(Date.now() - DUP_LOOKBACK_DAYS * 86400 * 1000).toISOString();
      const priorSig = await supabase
        .from('signals')
        .select('body_for_embedding')
        .eq('workspace_id', workspace_id)
        .eq('entity_id', entity_id)
        .eq('type', 'research_result')
        .gte('observed_at', dupSince)
        .order('observed_at', { ascending: false })
        .limit(60);
      const priorBodies = ((priorSig.data ?? []) as Array<{ body_for_embedding: string | null }>)
        .map((s) => s.body_for_embedding ?? '')
        .filter(Boolean);
      const { keep: dedupKeep, dropped: duplicates_dropped } = await dedupeResearchCandidates(acceptedOrdered, priorBodies);

      // --- Create phase: only accepted, non-duplicate results become signals. ---
      // Hook-class weights (HOOK_CLASS_WEIGHT, from scoring.ts): a page that only
      // confirms the company fits a market ("profile") is background, not a
      // trigger, so its signal starts at half magnitude; evidence of a current
      // push ("direction") is close to full; a dated event keeps full.
      // Unclassified (own-domain auto-accept, gate fallback) keeps full —
      // unchanged behavior for unconfigured workspaces.
      let created = 0;
      let firstSignalId: string | null = null;
      const perAngle: Record<string, number> = {};
      const perClass: Record<string, number> = {};
      // Create in class order (event > direction > profile). The burst coalescer
      // only fully enriches the FIRST signal of a batch, and the direct dispatch
      // below fires on firstSignalId — so the enricher should read the launch
      // story, not whichever fit-confirmation page happened to fetch first.
      const createOrder = [...candidates].sort((a, b) =>
        (HOOK_CLASS_WEIGHT[hookClassById.get(b.er.id) ?? ''] ?? 1) - (HOOK_CLASS_WEIGHT[hookClassById.get(a.er.id) ?? ''] ?? 1));
      for (const c of createOrder) {
        if (!acceptedIds.has(c.er.id) || !dedupKeep.has(c.er.id)) continue;
        const body = [c.er.title, c.er.text].filter(Boolean).join('\n').slice(0, 1500);
        if (!body) continue;
        const hookClass = hookClassById.get(c.er.id);
        try {
          const sig = await callTool(supabase, actor, 'create_signal', {
            entity_id,
            type: 'research_result',
            // Base 0.6, decayed by how old the source is (halves every
            // half-life days) and by hook class. A fresh launch keeps ~0.6; an
            // older-but-passing article or a fit-confirmation page is visibly
            // weaker so it can't outrank current news.
            magnitude: researchSignalMagnitude(c.er.publishedDate, halfLifeDays, hookClass),
            body_for_embedding: body,
            structured_tags: {
              signal_source: 'research',
              research_angle: c.angleId,
              research_kind: kind,
              exa_id: c.er.id,
              url: c.er.url,
              published_at: c.er.publishedDate ?? null,
              ...(c.er.overruledPublishedDate
                ? { published_at_source: 'url', published_at_reported: c.er.overruledPublishedDate }
                : {}),
              triggered_by: reason,
              ...(hookClass ? { hook_class: hookClass } : {}),
            },
          });
          if (sig.ok) {
            created++;
            perAngle[c.angleId] = (perAngle[c.angleId] ?? 0) + 1;
            perClass[hookClass ?? 'unclassified'] = (perClass[hookClass ?? 'unclassified'] ?? 0) + 1;
            if (!firstSignalId && sig.target_id) firstSignalId = sig.target_id;
          }
        } catch {
          // partial failure is acceptable for a research pull
        }
      }

      // The dispatcher already decided this entity deserves research, so the
      // results must reach the enricher — they must not sit in a similarity
      // lottery against the subscription embedding (measured: 25 of 28 research
      // signals fell below the threshold and the batch produced zero facts).
      // Dispatch the enricher directly on the first created signal; the burst
      // coalescer turns the rest of the batch into cheap skips.
      if (created > 0 && firstSignalId) {
        const enricherSub = (await supabase
          .from('subscriptions')
          .select('id, owner_id')
          .eq('workspace_id', workspace_id)
          .eq('agent_behavior', 'enricher')
          .eq('active', true)
          .order('created_at', { ascending: true })
          .limit(1)
          .maybeSingle()).data as { id: string; owner_id: string } | null;
        if (enricherSub) {
          try {
            await inngest.send({
              name: 'agent.run',
              // Same idempotency key the organic match path uses, so this signal
              // enriches once even though both paths fire for it. entity_id keys
              // the per-entity serialization that collapses the rest of the burst.
              id: `agentrun:${firstSignalId}:${enricherSub.owner_id}`,
              data: {
                workspace_id,
                agent: enricherSub.owner_id,
                trigger_event: 'manual',
                subscription_id: enricherSub.id,
                signal_id: firstSignalId,
                entity_id,
              },
            });
          } catch (e) {
            // The searches are already paid for and the signals exist; a
            // failed dispatch (Inngest outage, no event key in a local run)
            // must not throw the whole run away. The organic subscription
            // path can still pick the signals up.
            errors.push(`enricher dispatch failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }

      if (searches === 0) {
        await recordActivityMarker(supabase, actor, ACTIVITY_MARKERS.RESEARCH_ERROR, entity_id, {
          message: 'no runnable angles (missing domain / empty templates)',
          summary: 'research produced no searches',
        });
        return { ok: false, reason: 'no runnable angles' };
      }
      if (errors.length && created === 0) {
        await recordActivityMarker(supabase, actor, ACTIVITY_MARKERS.RESEARCH_ERROR, entity_id, {
          message: errors.slice(0, 3).join('; '),
          summary: `research errored on ${errors.length}/${searches} angles`,
        });
        // Every search failed on a credit/auth wall → every later run will fail
        // the same way. Pause the research loop loudly (banner + Continue) so
        // the operator sees it instead of the loop silently burning ticks for
        // days. Scope 'research' — scoring, contact pulls, and drafting keep
        // running. This ran unnoticed for 7 days when Exa first ran dry.
        if (errors.length === searches && errors.some((e) => isPersistentWall(e))) {
          const credit = errors.some((e) => /credit|402|payment/i.test(e));
          await setPipelineStatus(supabase, workspace_id, {
            state: 'paused',
            scope: 'research',
            provider: 'exa',
            reason: credit
              ? 'Exa (web research) is out of credit. Research is paused; scoring, contact pulls, and drafting continue. Add credits at dashboard.exa.ai, then click Continue.'
              : `Exa (web research) returned an error and research is paused: ${errors[0]?.slice(0, 140)}. Fix it, then click Continue.`,
            paused_at: new Date().toISOString(),
          });
        }
      }

      // Event-log marker the dispatcher / action_selector read to time the next pass.
      await recordActivityMarker(supabase, actor, ACTIVITY_MARKERS.RESEARCH_COMPLETED, entity_id, {
        results_created: created,
        searches,
        filtered_out,
        filtered_by,
        filtered_stale,
        filtered_no_name,
        same_url_dropped,
        duplicates_dropped,
        per_angle: perAngle,
        per_class: perClass,
        ...(resolver_spent ? { domain_resolved: domain || null } : {}),
        summary: `${created} results from ${searches} search(es)${filtered_out ? `, ${filtered_out} off-topic/same-name filtered` : ''}${filtered_no_name ? `, ${filtered_no_name} never named the company` : ''}${filtered_stale ? `, ${filtered_stale} stale dropped` : ''}${(same_url_dropped + duplicates_dropped) ? `, ${same_url_dropped + duplicates_dropped} duplicate dropped` : ''}${resolver_spent ? (domain ? `, domain resolved to ${domain}` : ', domain resolution found nothing safe') : ''}`,
      });

      return { ok: true, searches, signals_created: created, filtered_out, filtered_no_name, filtered_stale, same_url_dropped, duplicates_dropped, per_angle: perAngle, per_class: perClass, ...(resolver_spent ? { domain_resolved: domain || null } : {}), errors: errors.slice(0, 3) };
    }
  }
}
