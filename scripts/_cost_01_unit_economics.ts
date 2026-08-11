/**
 * What does it actually cost to run this thing, and what drives the cost?
 *
 * The pitch is that reads are token-efficient projections rather than row dumps,
 * so the agent is cheaper to run than a general assistant pointed at a CRM. That
 * claim is only worth making if LLM tokens are a material share of the bill and
 * if the per-account cost does not grow with the size of the book.
 *
 * Reads only. No LLM, no Exa, no writes.
 *
 * Usage: pnpm tsx scripts/_cost_01_unit_economics.ts [--days 30]
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { DEFAULT_PRICING } from '@agent-crm/tools';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const argv = process.argv.slice(2);
let DAYS = 30;
for (let i = 0; i < argv.length; i++) if (argv[i] === '--days') DAYS = Number(argv[++i]) || DAYS;

const usd = (n: number) => `$${n.toFixed(2)}`;
const per1m = (tokens: number, rate: number) => (tokens / 1_000_000) * rate;

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
  const ws = (await sb.from('workspaces').select('id, name').limit(50)).data ?? [];

  console.log(`window: last ${DAYS} days\n`);

  for (const w of ws as Array<{ id: string; name: string }>) {
    const metrics = await pageAll<any>((f, t) => sb.from('events').select('payload, created_at')
      .eq('workspace_id', w.id).eq('action', 'agent_run_metrics').gte('created_at', since).range(f, t));
    const research = await pageAll<any>((f, t) => sb.from('events').select('payload')
      .eq('workspace_id', w.id).eq('action', 'research_completed').gte('created_at', since).range(f, t));
    if (!metrics.length && !research.length) continue;

    const entities = (await sb.from('entities').select('id', { count: 'exact', head: true })
      .eq('workspace_id', w.id)).count ?? 0;
    const facts = (await sb.from('facts').select('id', { count: 'exact', head: true })
      .eq('workspace_id', w.id)).count ?? 0;

    // ---- LLM ----
    const byBehavior = new Map<string, { runs: number; in: number; out: number; cached: number; model: string }>();
    let llmCost = 0, tokensIn = 0, tokensOut = 0, cachedIn = 0;
    for (const e of metrics) {
      const p = e.payload ?? {};
      const model = p.model ?? 'unknown';
      const price = (DEFAULT_PRICING.models as Record<string, { input: number; cached: number; output: number }>)[model];
      const i = p.input_tokens ?? 0, o = p.output_tokens ?? 0, c = p.cached_input_tokens ?? 0;
      tokensIn += i; tokensOut += o; cachedIn += c;
      if (price) llmCost += per1m(i - c, price.input) + per1m(c, price.cached) + per1m(o, price.output);
      const k = p.behavior ?? 'unknown';
      const agg = byBehavior.get(k) ?? { runs: 0, in: 0, out: 0, cached: 0, model };
      agg.runs++; agg.in += i; agg.out += o; agg.cached += c;
      byBehavior.set(k, agg);
    }

    // ---- Exa ----
    const searches = research.reduce((n, e) => n + (e.payload?.searches ?? 0), 0);
    const exaCost = searches * DEFAULT_PRICING.exa_per_search;

    const total = llmCost + exaCost;
    if (total < 0.01 && !metrics.length) continue;

    console.log(`${'='.repeat(76)}`);
    console.log(`${w.name}  —  ${entities} entities, ${facts} facts`);
    console.log(`${'='.repeat(76)}`);
    console.log(`  LLM      ${usd(llmCost).padStart(9)}   ${(llmCost / (total || 1) * 100).toFixed(0)}%   ${metrics.length} calls, ${(tokensIn / 1e6).toFixed(1)}M in / ${(tokensOut / 1e6).toFixed(2)}M out`);
    console.log(`  Exa      ${usd(exaCost).padStart(9)}   ${(exaCost / (total || 1) * 100).toFixed(0)}%   ${searches} searches`);
    console.log(`  TOTAL    ${usd(total).padStart(9)}          ${usd(total / DAYS)}/day, ${usd((total / DAYS) * 30)}/month at this rate`);
    console.log(`  cache    ${cachedIn ? `${(cachedIn / (tokensIn || 1) * 100).toFixed(1)}% of input tokens were cached reads` : 'NO CACHED READS AT ALL'}`);
    if (entities) console.log(`  per entity in book: ${usd(total / entities)} over ${DAYS}d`);

    console.log(`\n  where the tokens go:`);
    const rows = [...byBehavior.entries()].sort((a, b) => (b[1].in + b[1].out) - (a[1].in + a[1].out));
    console.log(`    ${'behavior'.padEnd(28)}${'calls'.padStart(7)}${'in'.padStart(12)}${'out'.padStart(10)}${'avg in'.padStart(9)}${'cached'.padStart(9)}`);
    for (const [k, v] of rows.slice(0, 12)) {
      console.log(`    ${k.slice(0, 27).padEnd(28)}${String(v.runs).padStart(7)}${v.in.toLocaleString().padStart(12)}${v.out.toLocaleString().padStart(10)}${Math.round(v.in / v.runs).toLocaleString().padStart(9)}${(v.cached ? `${Math.round(v.cached / v.in * 100)}%` : '0').padStart(9)}`);
    }
    console.log('');
  }
})();
