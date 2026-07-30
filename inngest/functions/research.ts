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
  getPolicy, resolveEnvVar, resolveStrategy, runExaSearch, filterResultsByEntity, fetchEntityGrounding,
  dedupeResearchCandidates, DUP_LOOKBACK_DAYS, ageDecay,
  resolveDomainViaSearch, getPipelineStatus, setPipelineStatus,
} from '@agent-crm/tools';
import type { ResearchAngle, ExaResult } from '@agent-crm/tools';
import { isPersistentWall } from './advance_accounts.js';
import { inngest } from '../client.js';

const SEEN_WINDOW_DAYS = 30;
// Freshness defaults for the research path (policy.research.max_age_days /
// decay_half_life_days override). A dated source older than the floor never
// becomes a signal, regardless of scope; magnitude halves every half-life
// days of source age. An undated page is exempt from the floor (own-site
// evergreen pages — customer lists, general product pages — legitimately
// carry no date), but a page that DOES carry a date is held to the same
// month-scale bar an outreach hook needs: a two-year-old blog post is not a
// current trigger just because it's on the company's own domain.
const DEFAULT_MAX_AGE_DAYS = 30;
const DEFAULT_DECAY_HALF_LIFE_DAYS = 90;

/** Normalize a URL for exact same-source collapse: drop protocol, www, query, trailing slash. */
function normalizeUrl(u: string): string {
  try {
    const url = new URL(u);
    return `${url.hostname.replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return u.trim().toLowerCase();
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
): { query: string; params: Parameters<typeof runExaSearch>[1] } | null {
  const query = angle.query_template
    .replaceAll('{entity}', entity_name)
    .replaceAll('{domain}', domain)
    .replaceAll('{keywords}', keywords)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  if (!query) return null;

  const start_published_date = angle.recency_days
    ? new Date(Date.now() - angle.recency_days * 86400 * 1000).toISOString()
    : undefined;
  const num_results = angle.num_results ?? 3;

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
  if (angle.domain_scope === 'news') {
    return { query, params: { query, num_results, category: 'news', start_published_date, include_text: [entity_name] } };
  }
  if (angle.domain_scope === 'social') {
    // Exec posts/talks/interviews on the workspace-configured social hosts.
    // Searched by name, so results are NOT trusted — they go through the same
    // disambiguation gate as news/open_web (name collisions are worst here).
    if (!social_domains.length) return null; // scope not configured
    return { query, params: { query, num_results, start_published_date, include_domains: social_domains, include_text: [entity_name] } };
  }
  // open_web
  return { query, params: { query, num_results, start_published_date, include_text: [entity_name] } };
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
}

/**
 * Core of the research runner — exported so it can be invoked directly (scripts /
 * tests / a local loop) as well as from the Inngest handler above.
 */
export async function runEntityResearch(
  supabase: ReturnType<typeof createServerClient>,
  params: EntityResearchParams,
) {
  const { workspace_id, entity_id, entity_name, reason, angle_count } = params;
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

      // Entity domain drives the own_site angle + collision guards.
      const ent = await supabase.from('entities').select('attributes').eq('id', entity_id).maybeSingle();
      let domain = ((ent.data?.attributes as { domain?: string } | null)?.domain ?? '').trim().toLowerCase();

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
      if (!domain && policy.research?.resolve_domains !== false) {
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

      // The strategy is generated + cached by the dispatcher; the runner only
      // reads it. Slice the per-account angle budget from the angles that can
      // actually run for THIS entity: own_site needs a domain (one resolved
      // just above counts, so hot accounts get own-site results in the same
      // tick), and a positional slice handed domainless accounts (most of a
      // fresh CSV import) an own_site-only list, so they burned a dispatch
      // slot on zero searches. The resolver's search spends from the same
      // budget: a cold pick with angle_count=1 uses its tick on resolution
      // and researches on the next pick, which is fine and self-healing.
      const allAngles = resolveStrategy(policy);
      const socialDomains = (policy.research?.social_domains ?? []).filter(Boolean);
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

      // Freshness controls (policy override, else defaults). Applies to every
      // scope, including own_site — only an undated result is exempt (see gate
      // below); a dated own-site post is bound by the same floor as news.
      const maxAgeDays = policy.research?.max_age_days ?? DEFAULT_MAX_AGE_DAYS;
      const halfLifeDays = policy.research?.decay_half_life_days ?? DEFAULT_DECAY_HALF_LIFE_DAYS;
      const staleCutoffMs = Date.now() - maxAgeDays * 86400 * 1000;

      // --- Fetch phase: collect candidates, separating own-site (collision-proof,
      // domain-scoped) from news/open_web (searched by name -> must be disambiguated). ---
      interface Candidate { angleId: string; scope: ResearchAngle['domain_scope']; er: ExaResult }
      const candidates: Candidate[] = [];
      const ownSiteSnippets: string[] = [];
      let filtered_stale = 0;
      for (const angle of toRun) {
        const built = buildAngleRequest(angle, entity_name, domain, keywords, socialDomains);
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
          if (er.publishedDate) {
            const pub = Date.parse(er.publishedDate);
            if (Number.isFinite(pub) && pub < staleCutoffMs) { filtered_stale++; continue; }
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
        const context = await entityContext(supabase, workspace_id, entity_id, grounding ? [grounding] : []);
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
      // Hook-class weights: a page that only confirms the company fits a market
      // ("profile") is background, not a trigger, so its signal starts at half
      // magnitude; evidence of a current push ("direction") is close to full; a
      // dated event keeps full. Unclassified (own-domain auto-accept, gate
      // fallback) keeps full — unchanged behavior for unconfigured workspaces.
      const HOOK_CLASS_WEIGHT: Record<string, number> = { event: 1, direction: 0.85, profile: 0.5 };
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
            magnitude: Number((0.6 * ageDecay(c.er.publishedDate, halfLifeDays) * (HOOK_CLASS_WEIGHT[hookClass ?? ''] ?? 1)).toFixed(3)),
            body_for_embedding: body,
            structured_tags: {
              signal_source: 'research',
              research_angle: c.angleId,
              exa_id: c.er.id,
              url: c.er.url,
              published_at: c.er.publishedDate ?? null,
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
        same_url_dropped,
        duplicates_dropped,
        per_angle: perAngle,
        per_class: perClass,
        ...(resolver_spent ? { domain_resolved: domain || null } : {}),
        summary: `${created} results from ${searches} search(es)${filtered_out ? `, ${filtered_out} off-topic/same-name filtered` : ''}${filtered_stale ? `, ${filtered_stale} stale dropped` : ''}${(same_url_dropped + duplicates_dropped) ? `, ${same_url_dropped + duplicates_dropped} duplicate dropped` : ''}${resolver_spent ? (domain ? `, domain resolved to ${domain}` : ', domain resolution found nothing safe') : ''}`,
      });

      return { ok: true, searches, signals_created: created, filtered_out, filtered_stale, same_url_dropped, duplicates_dropped, per_angle: perAngle, per_class: perClass, ...(resolver_spent ? { domain_resolved: domain || null } : {}), errors: errors.slice(0, 3) };
    }
  }
}
