/**
 * Explorium linkedin_posts/enrich vs Exa contact_public_posts, head-to-head on
 * the same real Sudden contacts. See /Users/jakewatson/.claude/plans/sharded-rolling-gosling.md.
 *
 * Credit-capped: business match + prospect list are (per contacts.ts's existing
 * comment) free; only linkedin_posts/enrich is metered, and Explorium's docs say
 * it charges per prospect_id requested regardless of hit/miss. So we run the
 * FIRST enrich call alone, sanity-check its shape, then only proceed to the
 * remaining 4 if it looks like the documented response.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
import { getPolicy, resolveEnvVar } from '@agent-crm/tools';
import { runEntityResearch } from '../inngest/functions/research.ts';

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3'; // Sudden
const EXPLORIUM_API = 'https://api.explorium.ai/v1';
const MAX_ENRICH_CALLS = 5;

async function pageAll(supabase: any, table: string, sel: string, extra: (q: any) => any = (q) => q) {
  let from = 0;
  const out: any[] = [];
  for (;;) {
    const r = await extra(supabase.from(table).select(sel).eq('workspace_id', WS).range(from, from + 999));
    if (r.error) throw new Error(`${table}: ${r.error.message}`);
    out.push(...(r.data ?? []));
    if ((r.data ?? []).length < 1000) break;
    from += 1000;
  }
  return out;
}

async function pickCandidates(supabase: any) {
  const worksAt = await pageAll(supabase, 'facts', 'subject_entity, object_entity', (q: any) =>
    q.eq('predicate', 'works_at').is('supersedes', null));
  const accountByContact = new Map<string, string>();
  for (const r of worksAt) if (r.object_entity) accountByContact.set(r.subject_entity, r.object_entity);

  const scoreRows = await pageAll(supabase, 'facts', 'subject_entity, object_text', (q: any) =>
    q.eq('predicate', 'score_total').is('supersedes', null));
  const scoreByAccount = new Map<string, number>();
  for (const r of scoreRows) { const v = parseFloat(r.object_text ?? ''); if (Number.isFinite(v)) scoreByAccount.set(r.subject_entity, v); }

  const sigs = await pageAll(supabase, 'signals', 'entity_id, structured_tags', (q: any) => q.eq('type', 'research_result'));
  const alreadyResearched = new Set(
    sigs.filter((s: any) => s.structured_tags?.research_kind === 'contact' && s.structured_tags?.research_angle === 'contact_public_posts')
      .map((s: any) => s.entity_id),
  );

  const qualified = [...accountByContact.entries()]
    .filter(([c, acc]) => (scoreByAccount.get(acc) ?? 0) >= 0.6 && !alreadyResearched.has(c))
    .map(([c, acc]) => ({ contact_id: c, account_id: acc, score: scoreByAccount.get(acc) ?? 0 }))
    .sort((a, b) => b.score - a.score);

  const contactIds = qualified.map((q) => q.contact_id);
  const accountIds = [...new Set(qualified.map((q) => q.account_id))];
  const [contactEnts, accountEnts, roleRows] = await Promise.all([
    pageAll(supabase, 'entities', 'id, name', (q: any) => q.in('id', contactIds.slice(0, 200))),
    pageAll(supabase, 'entities', 'id, name, attributes', (q: any) => q.in('id', accountIds)),
    pageAll(supabase, 'facts', 'subject_entity, object_text', (q: any) => q.eq('predicate', 'role').is('supersedes', null).in('subject_entity', contactIds.slice(0, 200))),
  ]);
  const nameById = new Map(contactEnts.map((e: any) => [e.id, e.name]));
  const roleById = new Map(roleRows.map((r: any) => [r.subject_entity, r.object_text ?? '']));
  const accountById = new Map(accountEnts.map((e: any) => [e.id, e]));

  const all = qualified
    .map((q) => {
      const acc = accountById.get(q.account_id);
      return {
        contact_id: q.contact_id,
        name: nameById.get(q.contact_id) as string,
        role: roleById.get(q.contact_id) ?? '',
        score: q.score,
        account_name: acc?.name ?? '',
        domain: (acc?.attributes as { domain?: string } | undefined)?.domain ?? '',
      };
    })
    .filter((c) => c.name && c.domain);

  // One contact per domain — the point is 5 different companies, not 5 people
  // at one. (listProspectsForDomain now caches per domain regardless, but
  // picking distinct companies up front is the actual test intent, and also
  // means each candidate needs at most one match+list call, not a wasted one.)
  const seenDomains = new Set<string>();
  return all.filter((c) => {
    if (seenDomains.has(c.domain)) return false;
    seenDomains.add(c.domain);
    return true;
  });
}

// One match + one list call per unique domain, cached — never once per contact.
// Multiple contacts routinely share an account/domain, and both calls are
// metered (contrary to the assumption this script started with: see
// feedback_dedupe_before_metered_api_loops.md), so re-fetching the same
// business once per contact multiplies real spend for no new data.
const businessListCache = new Map<string, { error: string } | { prospects: Array<{ prospect_id?: string; full_name?: string }> }>();

async function listProspectsForDomain(apiKey: string, domain: string) {
  const cached = businessListCache.get(domain);
  if (cached) return cached;

  const headers = { api_key: apiKey, 'Content-Type': 'application/json' };
  const matchRes = await fetch(`${EXPLORIUM_API}/businesses/match`, {
    method: 'POST', headers, body: JSON.stringify({ businesses_to_match: [{ domain }] }),
  });
  if (!matchRes.ok) {
    const r = { error: `match ${matchRes.status}: ${(await matchRes.text()).slice(0, 200)}` };
    businessListCache.set(domain, r);
    return r;
  }
  const matchJson = (await matchRes.json()) as { matched_businesses?: Array<{ business_id?: string | null }> };
  const businessId = matchJson.matched_businesses?.[0]?.business_id;
  if (!businessId) {
    const r = { error: 'no business match' };
    businessListCache.set(domain, r);
    return r;
  }

  // page_size kept small (5, not 20): if this endpoint bills per row returned
  // (unconfirmed, but consistent with how fast the first key's trial vanished),
  // a smaller page shrinks exposure. We only need one specific named person per
  // company, not the full roster.
  const prospectsRes = await fetch(`${EXPLORIUM_API}/prospects`, {
    method: 'POST', headers,
    body: JSON.stringify({ mode: 'full', page: 1, page_size: 5, filters: { business_id: { type: 'includes', values: [businessId] } } }),
  });
  if (!prospectsRes.ok) {
    const r = { error: `prospects ${prospectsRes.status}: ${(await prospectsRes.text()).slice(0, 200)}` };
    businessListCache.set(domain, r);
    return r;
  }
  const prospectsJson = (await prospectsRes.json()) as { data?: Array<{ prospect_id?: string; full_name?: string }> };
  const r = { prospects: prospectsJson.data ?? [] };
  businessListCache.set(domain, r);
  return r;
}

async function findProspectId(apiKey: string, domain: string, contactName: string) {
  const listed = await listProspectsForDomain(apiKey, domain);
  if ('error' in listed) return listed;
  const needle = contactName.toLowerCase().trim();
  const hit = listed.prospects.find((p) => (p.full_name ?? '').toLowerCase().trim() === needle);
  if (!hit?.prospect_id) return { error: `no prospect_id match for "${contactName}" among ${listed.prospects.length} prospects` };
  return { prospect_id: hit.prospect_id };
}

async function enrichSocial(apiKey: string, prospectId: string) {
  const res = await fetch(`${EXPLORIUM_API}/prospects/linkedin_posts/enrich`, {
    method: 'POST',
    headers: { api_key: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prospect_id: prospectId }),
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { return { ok: false, raw: text, status: res.status }; }
  return { ok: res.ok, json, status: res.status };
}

function looksLikeDocumentedShape(json: any): boolean {
  return !!json && typeof json === 'object' && 'response_context' in json && 'data' in json;
}

async function main() {
  const supabase = createServerClient();
  const policy = await getPolicy(supabase, WS);
  const apiKey = resolveEnvVar(policy, 'EXPLORIUM_API_KEY');
  if (!apiKey) throw new Error('EXPLORIUM_API_KEY not resolved (policy.env or process.env)');

  const candidates = await pickCandidates(supabase);
  console.log(`candidate pool: ${candidates.length} qualified, unresearched contacts\n`);

  const matched: Array<{ contact_id: string; name: string; role: string; account_name: string; score: number; prospect_id: string }> = [];
  for (const c of candidates) {
    if (matched.length >= MAX_ENRICH_CALLS) break;
    const r = await findProspectId(apiKey, c.domain, c.name);
    if ('prospect_id' in r) {
      matched.push({ contact_id: c.contact_id, name: c.name, role: c.role, account_name: c.account_name, score: c.score, prospect_id: r.prospect_id });
      console.log(`MATCH  ${c.name} (${c.account_name}) -> prospect_id ${r.prospect_id}`);
    } else {
      console.log(`SKIP   ${c.name} (${c.account_name}) -> ${r.error}`);
      if (/insufficient credit/i.test(r.error)) {
        console.log('\nSTOPPING: account is out of credits. Not trying further domains.');
        break;
      }
    }
  }
  console.log(`\nmatched ${matched.length} contacts to a prospect_id (this many linkedin_posts/enrich calls will run, capped at ${MAX_ENRICH_CALLS})\n`);
  if (!matched.length) { console.log('nothing to enrich, stopping.'); return; }

  // Pilot call: run #1 alone, sanity-check the shape before spending on the rest.
  const first = matched[0];
  console.log(`--- pilot call: ${first.name} ---`);
  const pilot = await enrichSocial(apiKey, first.prospect_id);
  console.log(JSON.stringify(pilot, null, 2).slice(0, 2000));
  const explorium: Record<string, any> = {};
  if (!pilot.ok || !looksLikeDocumentedShape(pilot.json)) {
    console.log('\nPILOT RESPONSE DOES NOT MATCH DOCUMENTED SHAPE (response_context + data). Stopping before the remaining calls.');
    explorium[first.contact_id] = pilot;
  } else {
    explorium[first.contact_id] = pilot;
    console.log('\npilot shape OK, continuing with remaining calls...\n');
    for (const m of matched.slice(1)) {
      const r = await enrichSocial(apiKey, m.prospect_id);
      explorium[m.contact_id] = r;
      console.log(`  ${m.name}: status=${r.status} ok=${r.ok}`);
      if (r.status === 403) {
        console.log('  STOPPING: 403 on enrich, likely out of credits. Not trying the rest.');
        break;
      }
    }
  }

  // Exa side, same contacts.
  console.log('\n--- Exa contact_public_posts, same contacts ---');
  const exa: Record<string, any> = {};
  const since = new Date();
  for (const m of matched) {
    const r = await runEntityResearch(supabase, {
      workspace_id: WS, entity_id: m.contact_id, entity_name: m.name,
      reason: 'explorium-vs-exa-test', kind: 'contact',
    });
    console.log(`  ${m.name}: ${JSON.stringify(r)}`);
    const sig = await supabase.from('signals')
      .select('structured_tags, body_for_embedding, observed_at')
      .eq('workspace_id', WS).eq('entity_id', m.contact_id).eq('type', 'research_result')
      .gte('observed_at', since.toISOString())
      .order('observed_at', { ascending: false }).limit(1).maybeSingle();
    exa[m.contact_id] = sig.data ?? null;
  }

  // Comparison table.
  console.log('\n=== COMPARISON ===');
  let exaHits = 0, explHits = 0;
  const exaAges: number[] = [], explAges: number[] = [];
  for (const m of matched) {
    const e = exa[m.contact_id];
    const exHit = !!e;
    if (exHit) exaHits++;
    const exAge = e?.structured_tags?.published_at ? Math.round((Date.now() - Date.parse(e.structured_tags.published_at)) / 86400000) : null;
    if (exAge != null) exaAges.push(exAge);

    const ex = explorium[m.contact_id];
    const data = ex?.json?.data;
    const post = Array.isArray(data) ? data[0] : data;
    const explHit = ex?.ok && ex?.json?.response_context?.request_status === 'success' && !!post;
    if (explHit) explHits++;
    if (post?.days_since_posted != null) explAges.push(post.days_since_posted);

    console.log(`\n${m.name} (${m.role || 'no role'}) @ ${m.account_name}, score ${m.score.toFixed(2)}`);
    console.log(`  Exa:       ${exHit ? `HIT  ${e.structured_tags?.url ?? ''}  published_at=${e.structured_tags?.published_at ?? 'undated'}  (${exAge ?? '?'}d old)` : 'no hit'}`);
    console.log(`  Explorium: ${explHit ? `HIT  ${post.post_url}  created_at=${post.created_at}  (${post.days_since_posted}d old, ${post.number_of_likes}L/${post.number_of_comments}C)` : `no hit (status=${ex?.status}, request_status=${ex?.json?.response_context?.request_status})`}`);
  }

  console.log('\n=== SUMMARY ===');
  console.log(`n = ${matched.length}`);
  console.log(`Exa hit rate:       ${exaHits}/${matched.length}  avg age ${exaAges.length ? (exaAges.reduce((a, b) => a + b, 0) / exaAges.length).toFixed(0) : 'n/a'}d`);
  console.log(`Explorium hit rate: ${explHits}/${matched.length}  avg age ${explAges.length ? (explAges.reduce((a, b) => a + b, 0) / explAges.length).toFixed(0) : 'n/a'}d`);
  console.log(`\ncost: Exa ~$0.007/call x ${matched.length} = $${(0.007 * matched.length).toFixed(3)}`);
  console.log(`      Explorium ~$0.04/credit x ${matched.length} enrich calls (assuming 1 credit/call) = $${(0.04 * matched.length).toFixed(3)} equivalent (spent from free 100-credit trial)`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
