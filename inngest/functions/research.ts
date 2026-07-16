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
  resolveDomainViaSearch, getPipelineStatus, setPipelineStatus,
} from '@agent-crm/tools';
import type { ResearchAngle, ExaResult } from '@agent-crm/tools';
import { isHaltingError } from './advance_accounts.js';
import { inngest } from '../client.js';

const SEEN_WINDOW_DAYS = 30;
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
function buildAngleRequest(
  angle: ResearchAngle,
  entity_name: string,
  domain: string,
  keywords: string,
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
  const num_results = angle.num_results ?? 4;

  if (angle.domain_scope === 'own_site') {
    if (!domain) return null; // can't scope to a site we don't know
    // No recency on own-site: a company's own blog/product/customer pages are worth
    // surfacing regardless of age, and date-filtering an own-domain search tends to
    // return nothing (their pages aren't always freshly dated/indexed).
    return { query, params: { query, num_results, include_domains: [domain] } };
  }
  if (angle.domain_scope === 'news') {
    return { query, params: { query, num_results, category: 'news', start_published_date, include_text: [entity_name] } };
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
      const runnable = allAngles.filter((a) => a.domain_scope !== 'own_site' || !!domain);
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

      // --- Fetch phase: collect candidates, separating own-site (collision-proof,
      // domain-scoped) from news/open_web (searched by name -> must be disambiguated). ---
      interface Candidate { angleId: string; scope: ResearchAngle['domain_scope']; er: ExaResult }
      const candidates: Candidate[] = [];
      const ownSiteSnippets: string[] = [];
      for (const angle of toRun) {
        const built = buildAngleRequest(angle, entity_name, domain, keywords);
        if (!built) continue;
        searches++;
        const res = await runExaSearch(apiKey, built.params);
        if (!res.ok) {
          errors.push(`${angle.id}: Exa ${res.status ?? ''} ${res.error ?? ''}`.trim());
          continue;
        }
        for (const er of res.results) {
          if (!er.id || seenIds.has(er.id)) continue;
          seenIds.add(er.id); // dedup within this run too
          candidates.push({ angleId: angle.id, scope: angle.domain_scope, er });
          if (angle.domain_scope === 'own_site') {
            const snip = [er.title, (er.text ?? '').slice(0, 200)].filter(Boolean).join(' — ');
            if (snip) ownSiteSnippets.push(snip);
          }
        }
      }

      // --- Relevance phase: own-site results are trusted; everything else must pass the
      // same-name disambiguation gate (domain-host auto-accept, else one LLM check). ---
      const ownIds = new Set(candidates.filter((c) => c.scope === 'own_site').map((c) => c.er.id));
      const toGate = candidates
        .filter((c) => c.scope !== 'own_site')
        .map((c) => ({ id: c.er.id, title: c.er.title, url: c.er.url, text: c.er.text }));
      let collisions_dropped = 0;
      const acceptedIds = new Set<string>(ownIds);
      if (toGate.length) {
        // Ground the disambiguation in the company's own words. Reuse own-site snippets
        // when we have them; otherwise fetch the homepage so a thin, common-named entity
        // (no facts, own-site not indexed) still anchors to the right company.
        let grounding = ownSiteSnippets.slice(0, 2).join(' | ');
        if (!grounding && domain) grounding = await fetchEntityGrounding(apiKey, entity_name, domain);
        const context = await entityContext(supabase, workspace_id, entity_id, grounding ? [grounding] : []);
        const rel = await filterResultsByEntity({ name: entity_name, domain, context }, toGate);
        for (const id of rel.accepted) acceptedIds.add(id);
        collisions_dropped = rel.dropped;
      }

      // --- Create phase: only accepted results become signals. ---
      let created = 0;
      let firstSignalId: string | null = null;
      const perAngle: Record<string, number> = {};
      for (const c of candidates) {
        if (!acceptedIds.has(c.er.id)) continue;
        const body = [c.er.title, c.er.text].filter(Boolean).join('\n').slice(0, 1500);
        if (!body) continue;
        try {
          const sig = await callTool(supabase, actor, 'create_signal', {
            entity_id,
            type: 'research_result',
            magnitude: 0.6,
            body_for_embedding: body,
            structured_tags: {
              signal_source: 'research',
              research_angle: c.angleId,
              exa_id: c.er.id,
              url: c.er.url,
              published_at: c.er.publishedDate ?? null,
              triggered_by: reason,
            },
          });
          if (sig.ok) {
            created++;
            perAngle[c.angleId] = (perAngle[c.angleId] ?? 0) + 1;
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
              data: {
                workspace_id,
                agent: enricherSub.owner_id,
                trigger_event: 'manual',
                subscription_id: enricherSub.id,
                signal_id: firstSignalId,
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
        if (errors.length === searches && errors.some((e) => isHaltingError(e))) {
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
        collisions_dropped,
        per_angle: perAngle,
        ...(resolver_spent ? { domain_resolved: domain || null } : {}),
        summary: `${created} results from ${searches} search(es)${collisions_dropped ? `, ${collisions_dropped} same-name dropped` : ''}${resolver_spent ? (domain ? `, domain resolved to ${domain}` : ', domain resolution found nothing safe') : ''}`,
      });

      return { ok: true, searches, signals_created: created, collisions_dropped, per_angle: perAngle, ...(resolver_spent ? { domain_resolved: domain || null } : {}), errors: errors.slice(0, 3) };
    }
  }
}
