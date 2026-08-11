/**
 * Does this hold at scale, and what breaks first?
 *
 * Cost per workspace is bounded by config, not by book size:
 * searches_per_run (default 30) x 6 ticks/day is a hard ceiling on Exa spend, and
 * the LLM is 6% of the bill. So the bill does NOT grow with the book. What grows
 * is the gap between visits, because a fixed search budget spread over more
 * accounts means each one is looked at less often — and the drafter needs a
 * trigger inside trigger_fresh_days to lead with news.
 *
 * This measures the real coverage today and projects it.
 *
 * Reads only.
 *
 * Usage: pnpm tsx scripts/_cost_05_scaling.ts [--days 30]
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { getPolicy, DEFAULT_PRICING, DEFAULT_RESEARCH_SEARCHES_PER_RUN } from '@agent-crm/tools';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const argv = process.argv.slice(2);
let DAYS = 30;
for (let i = 0; i < argv.length; i++) if (argv[i] === '--days') DAYS = Number(argv[++i]) || DAYS;

async function pageAll<T>(build: (f: number, t: number) => any): Promise<T[]> {
  let out: T[] = []; let f = 0;
  for (;;) {
    const { data, error } = await build(f, f + 999);
    if (error) throw error;
    if (!data?.length) break;
    out = out.concat(data);
    if (data.length < 1000) break;
    f += 1000;
  }
  return out;
}

(async () => {
  const since = new Date(Date.now() - DAYS * 86400 * 1000).toISOString();
  const policy = await getPolicy(sb as any, WS);
  const perRun = policy.research?.searches_per_run ?? DEFAULT_RESEARCH_SEARCHES_PER_RUN;
  const ticksPerDay = 6; // '0 */4 * * *'

  const total = (await sb.from('entities').select('id', { count: 'exact', head: true })
    .eq('workspace_id', WS).is('archived_at', null)).count ?? 0;

  // Researchable = has a domain. A domainless account is never a candidate.
  const ents = await pageAll<any>((f, t) => sb.from('entities').select('id, attributes')
    .eq('workspace_id', WS).is('archived_at', null).range(f, t));
  const withDomain = ents.filter((e) => (e.attributes as any)?.domain).length;

  const runs = await pageAll<any>((f, t) => sb.from('events')
    .select('target_id, created_at, payload').eq('workspace_id', WS)
    .eq('action', 'research_completed').gte('created_at', since).range(f, t));
  const touched = new Set(runs.map((r) => r.target_id).filter(Boolean));
  const searches = runs.reduce((n, r) => n + (r.payload?.searches ?? 0), 0);

  const ceilingSearches = perRun * ticksPerDay * DAYS;
  const ceilingUsd = ceilingSearches * DEFAULT_PRICING.exa_per_search;
  const actualUsd = searches * DEFAULT_PRICING.exa_per_search;

  console.log(`\nbook: ${total} accounts, ${withDomain} with a domain (${((withDomain / (total || 1)) * 100).toFixed(0)}% are even researchable)\n`);

  console.log('cost is capped by config, not by book size:');
  console.log(`  searches_per_run ${perRun} x ${ticksPerDay} ticks/day x ${DAYS}d  = ${ceilingSearches.toLocaleString()} searches ceiling = $${ceilingUsd.toFixed(2)}`);
  console.log(`  actually spent                            = ${searches.toLocaleString()} searches = $${actualUsd.toFixed(2)}  (${((searches / ceilingSearches) * 100).toFixed(0)}% of ceiling)`);
  console.log(`  -> doubling the book does not raise this. The ceiling is the same at 2k accounts and 20k.`);

  console.log(`\nwhat actually degrades — coverage:`);
  console.log(`  distinct accounts researched in ${DAYS}d   ${touched.size}`);
  console.log(`  as a share of researchable                ${((touched.size / (withDomain || 1)) * 100).toFixed(1)}%`);
  const visitsPerAccountPerYear = (touched.size / (withDomain || 1)) * (365 / DAYS);
  console.log(`  implied visits per account per year       ${visitsPerAccountPerYear.toFixed(1)}`);
  console.log(`  implied gap between visits                ${(365 / (visitsPerAccountPerYear || 0.01)).toFixed(0)} days`);

  const freshDays = policy.drafter?.trigger_fresh_days ?? 14;
  const triggerMax = policy.drafter?.trigger_max_age_days ?? 90;
  console.log(`\n  the drafter leads with news only inside trigger_fresh_days = ${freshDays}d,`);
  console.log(`  and will use a fact as theme evidence up to trigger_max_age_days = ${triggerMax}d.`);
  console.log(`  A ${(365 / (visitsPerAccountPerYear || 0.01)).toFixed(0)}-day gap means most accounts are ${(365 / (visitsPerAccountPerYear || 0.01)) > triggerMax ? 'OUTSIDE even the theme window when their turn comes' : 'inside the theme window but outside the news window'}.`);

  console.log(`\nprojection at the same $${(actualUsd / DAYS * 30).toFixed(2)}/month budget:`);
  console.log(`  ${'researchable'.padEnd(14)}${'gap between visits'.padStart(20)}${'draftable on fresh news'.padStart(26)}`);
  const perAccountPerMonth = touched.size / DAYS * 30;
  for (const size of [500, withDomain, 5000, 10000, 25000]) {
    const gap = size / (perAccountPerMonth || 1) * 30;
    const share = Math.min(1, freshDays / gap);
    console.log(`  ${String(size).padEnd(14)}${`${gap.toFixed(0)} days`.padStart(20)}${`${(share * 100).toFixed(1)}%`.padStart(26)}`);
  }
  console.log(`\n  (draftable = share of the book whose newest research is inside the ${freshDays}-day news window at any moment)`);
})();
