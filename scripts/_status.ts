/**
 * One-shot pipeline status — "is everything running, and show me real signals."
 *
 *   pnpm status                     # full overview
 *   pnpm status <signal_type>       # dump 20 most recent signals of that type (full body + tags)
 *   pnpm status <signal_type> 50    # ...N most recent
 *   WORKSPACE_ID=<uuid> pnpm status    # override the workspace for one run
 *
 * Reads prod Supabase via .env.local (service role). Pure read-only.
 * WORKSPACE_ID is required and lives in .env.local — there is no default, because
 * a wrong default reports a healthy workspace as dead (or the reverse).
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { MODEL_PRICES, cost as priceCost, EXA_PRICE, exaSearchCost } from '../benchmark/v1/lib/pricing.js';

// Mirrors MAX_RESULTS in inngest/functions/research.ts — each research Exa call
// pulls text contents for this many pages, which is what Exa bills for.
const RESEARCH_NUM_RESULTS = 8;

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const ws = process.env.WORKSPACE_ID;
if (!ws) {
  console.error('WORKSPACE_ID is not set. Add it to .env.local, or pass it inline: WORKSPACE_ID=<uuid> pnpm status');
  process.exit(1);
}
const arg = process.argv[2];
const argN = parseInt(process.argv[3] ?? '20', 10);

const hAgo = (ts: string | null | undefined) =>
  ts ? `${((Date.now() - Date.parse(ts)) / 3600000).toFixed(1)}h` : 'never';

// Map entity_ids → names in one query.
async function names(ids: string[]): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return new Map();
  const { data } = await db.from('entities').select('id, name').in('id', uniq.slice(0, 200));
  return new Map((data ?? []).map((e: { id: string; name: string }) => [e.id, e.name]));
}

// ── DRILL-DOWN: dump recent signals of one type ───────────────────────────────
async function dumpSignals(type: string, n: number) {
  const { data } = await db
    .from('signals')
    .select('entity_id, magnitude, body_for_embedding, structured_tags, observed_at, created_at')
    .eq('workspace_id', ws)
    .eq('type', type)
    .order('created_at', { ascending: false })
    .limit(n);
  const rows = data ?? [];
  if (!rows.length) { console.log(`no "${type}" signals in this workspace.`); return; }
  const nm = await names(rows.map((r) => r.entity_id as string));
  console.log(`\n=== ${rows.length} most recent "${type}" signals ===\n`);
  for (const r of rows) {
    const tags = (r.structured_tags ?? {}) as Record<string, unknown>;
    const src = tags.signal_source ?? tags.source_id ?? '?';
    const url = tags.url ?? tags.item_url ?? tags.source_url ?? '';
    console.log(`• ${hAgo(r.created_at as string)} ago  ${nm.get(r.entity_id as string) ?? r.entity_id}  (mag ${r.magnitude}, src ${src})`);
    if (url) console.log(`    ${url}`);
    console.log(`    ${String(r.body_for_embedding ?? '').replace(/\s+/g, ' ').slice(0, 200)}`);
  }
}

// ── COST: price the agent_run_metrics events ──────────────────────────────────
type MetricRow = { payload: { model?: string; behavior?: string; input_tokens?: number; output_tokens?: number; cached_input_tokens?: number } | null; created_at: string };
type CostAgg = { runs: number; input: number; output: number; cached: number; cost: number; priced: boolean };

const bareModel = (m: string) => (m.includes('/') ? m.slice(m.lastIndexOf('/') + 1) : m);
const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

// Roll a set of metric rows up by a key (model or behavior), pricing each row.
function aggBy(rows: MetricRow[], key: 'model' | 'behavior'): Map<string, CostAgg> {
  const out = new Map<string, CostAgg>();
  for (const r of rows) {
    const p = r.payload ?? {};
    const model = p.model ?? 'unknown';
    const k = (key === 'model' ? model : (p.behavior ?? 'unknown'));
    const price = MODEL_PRICES[bareModel(model)];
    const inp = p.input_tokens ?? 0, outp = p.output_tokens ?? 0, cch = p.cached_input_tokens ?? 0;
    const a = out.get(k) ?? { runs: 0, input: 0, output: 0, cached: 0, cost: 0, priced: true };
    a.runs++; a.input += inp; a.output += outp; a.cached += cch;
    if (price) a.cost += priceCost(inp, outp, price, cch);
    else a.priced = false;
    out.set(k, a);
  }
  return out;
}

async function metricRows(sinceHours: number): Promise<MetricRow[]> {
  // Supabase caps a single response at 1000 rows, so page through with .range().
  const since = new Date(Date.now() - sinceHours * 3600000).toISOString();
  const all: MetricRow[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data } = await db.from('events')
      .select('payload, created_at')
      .eq('workspace_id', ws).eq('action', 'agent_run_metrics')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .range(from, from + page - 1);
    const rows = (data ?? []) as MetricRow[];
    all.push(...rows);
    if (rows.length < page) break;
  }
  return all;
}

const sumCost = (m: Map<string, CostAgg>) => [...m.values()].reduce((s, a) => s + a.cost, 0);
const anyUnpriced = (m: Map<string, CostAgg>) => [...m.values()].some((a) => !a.priced);

async function countFact(predicate: string, sinceHours: number): Promise<number> {
  const since = new Date(Date.now() - sinceHours * 3600000).toISOString();
  const { count } = await db.from('facts').select('id', { count: 'exact', head: true })
    .eq('workspace_id', ws).eq('predicate', predicate).gte('created_at', since);
  return count ?? 0;
}

// Exa web-search spend. The research loop is the metered path: one Exa search
// per completed (or errored) run. Discovery connectors (exa / exa_contacts)
// bill at the same per-search rate but aren't individually metered here.
async function exaCost(sinceHours: number): Promise<{ calls: number; cost: number }> {
  const [done, err] = await Promise.all([
    countFact('research_completed', sinceHours),
    countFact('research_error', sinceHours),
  ]);
  const calls = done + err;
  return { calls, cost: calls * exaSearchCost(RESEARCH_NUM_RESULTS) };
}

// Compact cost summary for the overview (last 7d, with 24h + run-rate).
async function costSummary() {
  const rows7d = await metricRows(24 * 7);
  console.log('\n── COST (LLM spend, priced from benchmark/v1/lib/pricing.ts) ──');
  if (!rows7d.length) { console.log('  no agent_run_metrics events in last 7d'); return; }
  const dayAgo = Date.now() - 86400000;
  const rows24 = rows7d.filter((r) => Date.parse(r.created_at) >= dayAgo);
  const byModel7d = aggBy(rows7d, 'model');
  const c7d = sumCost(byModel7d), c24 = sumCost(aggBy(rows24, 'model'));
  for (const [m, a] of [...byModel7d.entries()].sort((x, y) => y[1].cost - x[1].cost)) {
    const note = a.priced ? '' : '  (UNPRICED — add to pricing.ts)';
    console.log(`  ${m.padEnd(24)} ${String(a.runs).padStart(5)} runs  in ${a.input.toLocaleString().padStart(11)}  out ${a.output.toLocaleString().padStart(9)}  cache ${a.cached.toLocaleString().padStart(9)}  ${usd(a.cost).padStart(9)}${note}`);
  }
  const [exa7, exa24] = await Promise.all([exaCost(24 * 7), exaCost(24)]);
  const all7 = c7d + exa7.cost, all24 = c24 + exa24.cost;
  console.log(`  ${'─'.repeat(70)}`);
  console.log(`  LLM tokens   7d ${usd(c7d).padStart(9)}   24h ${usd(c24).padStart(9)}   ${usd(c7d / 7)}/day`);
  console.log(`  Exa research 7d ${usd(exa7.cost).padStart(9)}   24h ${usd(exa24.cost).padStart(9)}   ${usd(exa7.cost / 7)}/day   (${exa7.calls} searches 7d @ ${usd(exaSearchCost(RESEARCH_NUM_RESULTS))} ea)`);
  console.log(`  ALL-IN       7d ${usd(all7).padStart(9)}   24h ${usd(all24).padStart(9)}   ${usd(all7 / 7)}/day  ≈ ${usd((all7 / 7) * 30)}/mo`);
  if (anyUnpriced(byModel7d)) console.log('  note: UNPRICED models excluded from totals — add a sourced rate to benchmark/v1/lib/pricing.ts');
  console.log('  note: Exa = research-loop searches only; discovery exa/exa_contacts connectors bill the same per-search rate but are not metered here.');
}

// `pnpm status cost [hours]` — fuller breakdown by model and by behavior.
async function costDetail(hours: number) {
  const rows = await metricRows(hours);
  console.log(`\n=== LLM cost — last ${hours}h (${rows.length} agent_run_metrics events) ===`);
  if (!rows.length) return;
  const byModel = aggBy(rows, 'model');
  console.log('\nBY MODEL');
  for (const [m, a] of [...byModel.entries()].sort((x, y) => y[1].cost - x[1].cost))
    console.log(`  ${m.padEnd(24)} ${String(a.runs).padStart(5)} runs  in ${a.input.toLocaleString().padStart(11)}  cache-hit ${a.cached.toLocaleString().padStart(9)}  out ${a.output.toLocaleString().padStart(9)}  ${usd(a.cost).padStart(9)}${a.priced ? '' : '  (UNPRICED)'}`);
  console.log('\nBY BEHAVIOR');
  for (const [b, a] of [...aggBy(rows, 'behavior').entries()].sort((x, y) => y[1].cost - x[1].cost))
    console.log(`  ${b.padEnd(24)} ${String(a.runs).padStart(5)} runs  ${usd(a.cost).padStart(9)}${a.priced ? '' : '  (has unpriced model)'}`);
  const llm = sumCost(byModel);
  const exa = await exaCost(hours);
  console.log('\nEXA (web search)');
  console.log(`  research searches  ${String(exa.calls).padStart(5)}      @ ${usd(exaSearchCost(RESEARCH_NUM_RESULTS))} ea (1 search + ${RESEARCH_NUM_RESULTS} pages)  ${usd(exa.cost).padStart(9)}`);
  console.log(`  rate: ${EXA_PRICE.source}`);
  const total = llm + exa.cost;
  console.log(`  ${'─'.repeat(50)}`);
  console.log(`  LLM ${usd(llm)}  +  Exa ${usd(exa.cost)}  =  ${usd(total)}  over ${hours}h  ≈ ${usd(total / (hours / 24))}/day`);
}

// ── OVERVIEW ──────────────────────────────────────────────────────────────────
async function overview() {
  console.log(`workspace: ${ws}\n`);

  // 1. Active sources
  console.log('── SOURCES (active) ──');
  const { data: sources } = await db
    .from('sources')
    .select('name, connector_type, last_run_at, last_run_status, last_run_summary')
    .eq('workspace_id', ws).eq('active', true)
    .order('last_run_at', { ascending: false, nullsFirst: false });
  if (!sources?.length) console.log('  (none active)');
  for (const s of sources ?? []) {
    const sum = s.last_run_summary as { signals_created?: number; signals_7d?: number; skipped?: number } | null;
    console.log(`  ${s.name} (${s.connector_type})  ran ${hAgo(s.last_run_at as string)} ago [${s.last_run_status}]  created=${sum?.signals_created ?? '?'} 7d=${sum?.signals_7d ?? '?'} skipped=${sum?.skipped ?? '?'}`);
  }

  // 2. Signals — recent sample, by type
  const { count: sigTotal } = await db.from('signals').select('id', { count: 'exact', head: true }).eq('workspace_id', ws);
  const { data: sample } = await db
    .from('signals')
    .select('type, entity_id, body_for_embedding, structured_tags, created_at')
    .eq('workspace_id', ws)
    .order('created_at', { ascending: false })
    .limit(3000);
  const rows = sample ?? [];
  const dayAgo = Date.now() - 86400000;
  const byType = new Map<string, { total: number; d1: number; last: string }>();
  for (const r of rows) {
    const t = r.type as string;
    const e = byType.get(t) ?? { total: 0, d1: 0, last: r.created_at as string };
    e.total++;
    if (Date.parse(r.created_at as string) >= dayAgo) e.d1++;
    byType.set(t, e);
  }
  console.log(`\n── SIGNALS  (${sigTotal ?? 0} total; breakdown of the ${rows.length} most recent) ──`);
  for (const [t, e] of [...byType.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${t.padEnd(18)} ${String(e.total).padStart(5)}  | last 24h: ${e.d1}  | newest ${hAgo(e.last)} ago`);
  }

  // 3. Most recent real signals
  console.log('\n── 8 MOST RECENT SIGNALS ──');
  const recent = rows.slice(0, 8);
  const nm = await names(recent.map((r) => r.entity_id as string));
  for (const r of recent) {
    console.log(`  ${hAgo(r.created_at as string)} ago  [${r.type}]  ${nm.get(r.entity_id as string) ?? r.entity_id}`);
    console.log(`     ${String(r.body_for_embedding ?? '').replace(/\s+/g, ' ').slice(0, 140)}`);
  }

  // 4. Pipeline output (channel_posts via channels join)
  const { data: posts } = await db
    .from('channel_posts')
    .select('kind, created_at, channels!inner(workspace_id)')
    .eq('channels.workspace_id', ws)
    .order('created_at', { ascending: false })
    .limit(2000);
  const prows = (posts ?? []) as Array<{ kind: string; created_at: string }>;
  const wkAgo = Date.now() - 7 * 86400000;
  const byKind = new Map<string, { d1: number; d7: number }>();
  for (const p of prows) {
    const e = byKind.get(p.kind) ?? { d1: 0, d7: 0 };
    const t = Date.parse(p.created_at);
    if (t >= dayAgo) e.d1++;
    if (t >= wkAgo) e.d7++;
    byKind.set(p.kind, e);
  }
  console.log(`\n── PIPELINE OUTPUT (channel_posts; newest ${hAgo(prows[0]?.created_at)} ago) ──`);
  for (const [k, e] of [...byKind.entries()].sort((a, b) => b[1].d7 - a[1].d7)) {
    console.log(`  ${k.padEnd(14)} 24h: ${String(e.d1).padStart(4)}   7d: ${e.d7}`);
  }

  // 5. Enrichment loop markers
  console.log('\n── ENRICHMENT (research loop) ──');
  for (const pred of ['research_triggered', 'research_completed', 'research_error']) {
    const { count } = await db.from('facts').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).eq('predicate', pred);
    console.log(`  ${pred.padEnd(20)} ${count ?? 0}`);
  }
  const { count: rr } = await db.from('signals').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).eq('type', 'research_result');
  console.log(`  research_result sigs  ${rr ?? 0}`);

  // 6. Cost (LLM spend, priced)
  await costSummary();

  // 7. Pending approvals
  const { count: pending } = await db.from('gates').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).is('decided_at', null);
  console.log(`\n── GATES ──\n  pending approvals: ${pending ?? 0}`);

  console.log('\ntip: `pnpm status <signal_type>` to dump recent signals of one type (e.g. hiring_post, research_result).');
  console.log('tip: `pnpm status cost [hours]` for a full LLM-spend breakdown by model and behavior (default 168h).');
}

(async () => {
  if (arg === 'cost') await costDetail(parseInt(process.argv[3] ?? '168', 10));
  else if (arg) await dumpSignals(arg, argN);
  else await overview();
})();
