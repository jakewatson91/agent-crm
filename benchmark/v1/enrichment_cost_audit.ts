import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { MODEL_PRICES, DEFAULT_PRICE, cost, exaSearchCost, type ModelPrice } from './lib/pricing.ts';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = process.env.WS || 'e7052848-2270-41ac-90b6-d9b75c87f6d3'; // Sudden
const DAYS = Number(process.env.DAYS || 30);
const since = new Date(Date.now() - DAYS * 86400e3).toISOString();

// text-embedding-3-small: $0.02 / 1M tokens (openai.com/api/pricing, 2026). ~1 embed/signal (~400 tok), 4/score.
const EMBED_PER_M = 0.02;

function priceFor(model: string | undefined): ModelPrice {
  if (!model) return DEFAULT_PRICE;
  const m = model.toLowerCase();
  for (const [k, v] of Object.entries(MODEL_PRICES)) if (m.includes(k)) return v;
  if (m.includes('flash')) return MODEL_PRICES['deepseek-v4-flash'];
  if (m.includes('pro')) return MODEL_PRICES['deepseek-v4-pro'];
  return DEFAULT_PRICE;
}

async function fetchAll(action: string, cols: string) {
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('events').select(cols)
      .eq('workspace_id', WS).eq('action', action).gte('created_at', since)
      .order('created_at', { ascending: true }).range(from, from + 999);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

async function main() {
  console.log(`\n=== ENRICHMENT COST AUDIT — ws ${WS.slice(0, 8)} — last ${DAYS}d ===\n`);

  // 1. LLM cost by behavior, priced per actual model recorded on the run.
  const metrics = await fetchAll('agent_run_metrics',
    'created_at, payload') as Array<{ payload: any }>;
  const byBehavior = new Map<string, { runs: number; in: number; out: number; cached: number; usd: number; models: Set<string> }>();
  const entitiesTouched = new Set<string>();
  for (const e of metrics) {
    const p = e.payload ?? {};
    const b = p.behavior ?? '(unknown)';
    const rec = byBehavior.get(b) ?? { runs: 0, in: 0, out: 0, cached: 0, usd: 0, models: new Set() };
    const inp = p.input_tokens ?? 0, out = p.output_tokens ?? 0, cch = p.cached_input_tokens ?? 0;
    rec.runs++; rec.in += inp; rec.out += out; rec.cached += cch;
    rec.usd += cost(inp, out, priceFor(p.model), cch);
    if (p.model) rec.models.add(p.model);
    byBehavior.set(b, rec);
    if (p.entity_id) entitiesTouched.add(p.entity_id);
  }

  let llmUsd = 0, enrichUsd = 0, scoreUsd = 0;
  console.log('LLM cost by behavior (priced per run\'s actual model):');
  console.log('  behavior         runs     in_tok    out_tok    cached      $');
  for (const [b, r] of [...byBehavior.entries()].sort((a, c) => c[1].usd - a[1].usd)) {
    llmUsd += r.usd;
    if (b === 'enricher') enrichUsd = r.usd;
    if (b.startsWith('score') || b === 'scorer') scoreUsd += r.usd;
    console.log(`  ${b.padEnd(15)} ${String(r.runs).padStart(5)} ${String(r.in).padStart(10)} ${String(r.out).padStart(10)} ${String(r.cached).padStart(9)}  $${r.usd.toFixed(4)}  [${[...r.models].join(',') || '?'}]`);
  }

  // 2. Exa search cost from research_completed markers (payload.searches).
  const research = await fetchAll('research_completed', 'target_id, payload') as Array<{ target_id: string; payload: any }>;
  let searches = 0, resultsCreated = 0, researchRuns = 0;
  const accountsResearched = new Set<string>();
  for (const e of research) {
    const p = e.payload ?? {};
    if (e.target_id) accountsResearched.add(e.target_id);
    if (typeof p.searches === 'number') { searches += p.searches; researchRuns++; resultsCreated += (p.results_created ?? 0); }
  }
  // "Accounts worked" = distinct accounts that actually consumed research/enrich
  // spend in the window (research markers ∪ enricher runs). This is the honest
  // denominator for a per-account cost — NOT every account that has a fact (most
  // of those came near-free from the CSV import).
  const worked = new Set<string>([...accountsResearched, ...entitiesTouched]);
  const exaUsd = exaSearchCost(3) * searches; // ~3 content pages/search (DEFAULT_NUM_RESULTS)

  // 3. Signals + facts. Quality denominator = ACTIVE SUBSTANTIVE facts (distinct
  //    content_hash, excluding score_* / breakdown / admin bookkeeping), not the
  //    raw insert count (score facts are re-asserted every run and superseded).
  const { count: sigCount } = await sb.from('signals').select('id', { count: 'exact', head: true })
    .eq('workspace_id', WS).eq('type', 'research_result').gte('observed_at', since);
  const signals = sigCount ?? 0;
  // pull substantive fact rows (window) and de-dupe by content_hash
  const factRows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from('facts').select('content_hash, predicate, subject_entity')
      .eq('workspace_id', WS).gte('observed_at', since)
      .not('predicate', 'ilike', 'score%')
      .order('observed_at', { ascending: true }).range(from, from + 999);
    factRows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const admin = /(_breakdown$|^icp_fit|dropped_until|cooldown|_candidate|rescore|^lifecycle|^outreach_stage|marker)/i;
  const substantive = factRows.filter((f) => !admin.test(f.predicate));
  const facts = new Set(substantive.map((f) => f.content_hash)).size;
  const factAccounts = new Set(substantive.map((f) => f.subject_entity)).size;

  // 4. Scoring LLM cost — scoreEntity uses chatCompleteForWorkspace which does NOT
  //    self-log agent_run_metrics, so estimate from score_total assertions × the
  //    v1-benchmark measured per-score cost ($0.000495, agent-crm projection shape).
  const { count: scoreTotalCount } = await sb.from('facts').select('id', { count: 'exact', head: true })
    .eq('workspace_id', WS).eq('predicate', 'score_total').gte('observed_at', since);
  const scoreRuns = scoreTotalCount ?? 0;
  const SCORE_USD_PER_RUN = 0.000495;
  scoreUsd = scoreRuns * SCORE_USD_PER_RUN;

  // 5. Embedding cost estimate (small): ~400 tok/signal embed + 4×~200 tok/score embed.
  const embedTok = signals * 400 + scoreRuns * 4 * 200;
  const embedUsd = (embedTok * EMBED_PER_M) / 1_000_000;

  const totalUsd = llmUsd + scoreUsd + exaUsd + embedUsd;
  const accounts = entitiesTouched.size || 1;

  const accts = worked.size || 1;

  console.log(`\n--- Volume (${DAYS}d) ---`);
  console.log(`  ACCOUNTS WORKED (research∪enrich):${accts}`);
  console.log(`  accounts researched (markers):  ${accountsResearched.size}`);
  console.log(`  accounts with enricher runs:    ${accounts}`);
  console.log(`  accounts with substantive facts:${factAccounts}  (incl. CSV-import facts)`);
  console.log(`  research signals created:       ${signals}`);
  console.log(`  active substantive facts:       ${facts}  (distinct content_hash, score/admin excluded)`);
  console.log(`  score runs (score_total rows):  ${scoreRuns}`);
  console.log(`  Exa searches (markers):         ${searches}  over ${researchRuns} research runs → ${resultsCreated} results`);

  console.log(`\n--- Cost breakdown (USD, ${DAYS}d) ---`);
  console.log(`  Enricher LLM:     $${enrichUsd.toFixed(4)}`);
  console.log(`  Scoring LLM (est):$${scoreUsd.toFixed(4)}   (${scoreRuns} runs × $${SCORE_USD_PER_RUN})`);
  console.log(`  Drafter LLM:      $${(byBehavior.get('drafter')?.usd ?? 0).toFixed(4)}   (excluded from enrichment unit cost below)`);
  console.log(`  Exa search:       $${exaUsd.toFixed(4)}   (${searches} searches × ~$${exaSearchCost(3).toFixed(3)})`);
  console.log(`  Embeddings (est): $${embedUsd.toFixed(4)}`);
  const enrichTotal = enrichUsd + scoreUsd + exaUsd + embedUsd; // enrichment only (no drafter)
  console.log(`  ENRICHMENT TOTAL: $${enrichTotal.toFixed(4)}   (enricher + scoring + Exa + embeds)`);

  console.log(`\n--- Unit economics (enrichment, per account) ---`);
  console.log(`  $ / account (all-in):     $${(enrichTotal / accts).toFixed(4)}`);
  console.log(`  $ / research signal:      $${signals ? (enrichTotal / signals).toFixed(4) : 'n/a'}`);
  console.log(`  $ / substantive fact:     $${facts ? (enrichTotal / facts).toFixed(5) : 'n/a'}`);
  console.log(`  substantive facts / acct: ${(facts / accts).toFixed(1)}`);
  console.log(`  signals / account:        ${(signals / accts).toFixed(1)}`);
  console.log('');
}
main().catch((e) => { console.error(e); process.exit(1); });
