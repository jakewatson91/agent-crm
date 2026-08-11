/**
 * Is the fixed search budget buying COVERAGE or re-reading the same accounts?
 *
 * 3,937 searches bought 391 distinct accounts researched — 10 searches each,
 * against TIER_ANGLE_COUNT of 3 for a hot account and 1 for a default one. That
 * gap means the budget is going on repeat visits, not breadth. A hot account is
 * re-researched every 24h whether or not the web has anything new for it, and the
 * 30-day cross-run dedup means a drained account returns almost nothing.
 *
 * Also counts the fact-row churn, because 81,295 supersede_fact events in 30 days
 * against 7,378 assert_fact is the thing making reads expensive.
 *
 * Reads only.
 *
 * Usage: pnpm tsx scripts/_cost_09_budget_spread.ts [--days 30]
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { DEFAULT_PRICING } from '@agent-crm/tools';

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

  const runs = await pageAll<any>((f, t) => sb.from('events')
    .select('target_id, payload').eq('workspace_id', WS)
    .eq('action', 'research_completed').gte('created_at', since).range(f, t));

  const perAccount = new Map<string, { runs: number; searches: number; kept: number }>();
  for (const r of runs) {
    const id = r.target_id ?? 'unknown';
    const a = perAccount.get(id) ?? { runs: 0, searches: 0, kept: 0 };
    a.runs++;
    a.searches += r.payload?.searches ?? 0;
    a.kept += r.payload?.results_created ?? 0;
    perAccount.set(id, a);
  }

  const rows = [...perAccount.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.searches - a.searches);
  const totalSearches = rows.reduce((n, r) => n + r.searches, 0);

  console.log(`\n${runs.length} research runs over ${rows.length} distinct accounts, ${totalSearches} searches\n`);

  // How concentrated is the spend?
  let cum = 0; const marks = [0.25, 0.5, 0.8];
  const cuts: Record<string, number> = {};
  for (let i = 0; i < rows.length; i++) {
    cum += rows[i]!.searches;
    for (const m of marks) if (!cuts[String(m)] && cum >= totalSearches * m) cuts[String(m)] = i + 1;
  }
  console.log('concentration of the search budget:');
  for (const m of marks) {
    const n = cuts[String(m)] ?? rows.length;
    console.log(`  ${(m * 100).toFixed(0)}% of all searches went to the top ${n} accounts (${((n / rows.length) * 100).toFixed(0)}% of those researched)`);
  }

  console.log(`\nthe 12 accounts the budget actually went on:`);
  console.log(`  ${'runs'.padStart(6)}${'searches'.padStart(10)}${'kept'.padStart(7)}${'kept/search'.padStart(13)}   cost`);
  for (const r of rows.slice(0, 12)) {
    console.log(`  ${String(r.runs).padStart(6)}${String(r.searches).padStart(10)}${String(r.kept).padStart(7)}${(r.kept / (r.searches || 1)).toFixed(2).padStart(13)}   $${(r.searches * DEFAULT_PRICING.exa_per_search).toFixed(2)}`);
  }

  const repeat = rows.filter((r) => r.runs > 1);
  const repeatSearches = repeat.reduce((n, r) => n + r.searches, 0);
  const onceOnly = rows.filter((r) => r.runs === 1);
  console.log(`\nrepeat visits vs first visits:`);
  console.log(`  accounts visited more than once   ${repeat.length}  using ${repeatSearches} searches ($${(repeatSearches * DEFAULT_PRICING.exa_per_search).toFixed(2)})`);
  console.log(`  accounts visited exactly once     ${onceOnly.length}  using ${totalSearches - repeatSearches} searches`);
  const keptRepeat = repeat.reduce((n, r) => n + r.kept, 0);
  const keptOnce = onceOnly.reduce((n, r) => n + r.kept, 0);
  console.log(`  pages kept per search, repeats    ${(keptRepeat / (repeatSearches || 1)).toFixed(2)}`);
  console.log(`  pages kept per search, first-time ${(keptOnce / ((totalSearches - repeatSearches) || 1)).toFixed(2)}`);

  // Fact churn
  const ev = await pageAll<any>((f, t) => sb.from('events').select('action')
    .eq('workspace_id', WS).in('action', ['supersede_fact', 'assert_fact', 'rescore_noop'])
    .gte('created_at', since).range(f, t));
  const c = new Map<string, number>();
  for (const e of ev) c.set(e.action, (c.get(e.action) ?? 0) + 1);
  const sup = c.get('supersede_fact') ?? 0, asr = c.get('assert_fact') ?? 0;
  const factCount = (await sb.from('facts').select('id', { count: 'exact', head: true }).eq('workspace_id', WS)).count ?? 0;

  console.log(`\nfact-row churn (this is what makes every read expensive):`);
  console.log(`  supersede_fact  ${sup.toLocaleString()}`);
  console.log(`  assert_fact     ${asr.toLocaleString()}`);
  console.log(`  ratio           ${(sup / (asr || 1)).toFixed(1)} rewrites per genuinely new fact`);
  console.log(`  rescore_noop    ${(c.get('rescore_noop') ?? 0).toLocaleString()}  (work correctly avoided)`);
  console.log(`  facts table     ${factCount.toLocaleString()} rows today, growing ~${sup.toLocaleString()}/month from rewrites alone`);
})();
