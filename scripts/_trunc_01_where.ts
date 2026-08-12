/**
 * Where is the JSON-retry ladder actually firing?
 *
 * chatComplete retries a malformed/empty JSON response at 3x the budget and
 * then again on a fallback model, so ONE truncating call bills three. The
 * research page gate had this and was fixed (GATE_BATCH + index-addressed
 * verdicts). The question this answers is whether anything else still has it.
 *
 * Reads only: events, sources, workspaces.
 *
 * Usage: pnpm tsx scripts/_trunc_01_where.ts [--days 30]
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const argv = process.argv.slice(2);
let DAYS = 30;
for (let i = 0; i < argv.length; i++) if (argv[i] === '--days') DAYS = Number(argv[++i]) || DAYS;
const SINCE = new Date(Date.now() - DAYS * 86400 * 1000).toISOString();

async function pageAll<T>(build: (f: number, t: number) => any): Promise<T[]> {
  let out: T[] = []; let f = 0;
  for (;;) {
    const { data, error } = await build(f, f + 999);
    if (error) throw error;
    if (!data?.length) break;
    out = out.concat(data as T[]);
    if (data.length < 1000) break;
    f += 1000;
  }
  return out;
}

const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a');

(async () => {
  console.log(`window: last ${DAYS} days (since ${SINCE.slice(0, 10)})\n`);

  // ---------------------------------------------------------------
  // 1. The research page gate, post-fix. gate_unreadable counts batches
  //    whose response could not be parsed at all -> the full retry ladder ran.
  // ---------------------------------------------------------------
  const runs = await pageAll<any>((f, t) => sb.from('events')
    .select('workspace_id, target_id, created_at, payload')
    .eq('action', 'research_completed').gte('created_at', SINCE)
    .order('created_at', { ascending: true }).range(f, t));

  let unreadable = 0, omitted = 0, withGateField = 0;
  const unreadableByDay = new Map<string, number>();
  const runsByDay = new Map<string, number>();
  for (const r of runs) {
    const day = r.created_at.slice(0, 10);
    runsByDay.set(day, (runsByDay.get(day) ?? 0) + 1);
    const u = r.payload?.gate_unreadable;
    if (u !== undefined && u !== null) withGateField++;
    if (u) { unreadable += u; unreadableByDay.set(day, (unreadableByDay.get(day) ?? 0) + u); }
    omitted += r.payload?.gate_omitted ?? 0;
  }
  console.log('--- 1. research page gate ---');
  console.log(`research_completed runs: ${runs.length} (${withGateField} carry the gate fields)`);
  console.log(`unreadable batches (JSON unparseable -> full retry ladder): ${unreadable}`);
  console.log(`omitted pages (gate answered, skipped a page): ${omitted}`);
  if (unreadable) {
    console.log('by day:');
    for (const [d, n] of [...unreadableByDay.entries()].sort()) console.log(`  ${d}  ${n} unreadable / ${runsByDay.get(d)} runs`);
  }

  // ---------------------------------------------------------------
  // 2. Agent-side LLM failures. `unparseable_json` is the truncation shape.
  // ---------------------------------------------------------------
  const fails = await pageAll<any>((f, t) => sb.from('events')
    .select('workspace_id, created_at, payload')
    .eq('action', 'agent_llm_failed').gte('created_at', SINCE)
    .order('created_at', { ascending: true }).range(f, t));
  const byReason = new Map<string, number>();
  const byBehavior = new Map<string, number>();
  for (const f2 of fails) {
    const reason = f2.payload?.reason ?? 'unknown';
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
    const k = `${f2.payload?.behavior ?? '?'} / ${f2.payload?.model ?? '?'} / ${reason}`;
    byBehavior.set(k, (byBehavior.get(k) ?? 0) + 1);
  }
  console.log('\n--- 2. agent_llm_failed ---');
  console.log(`total: ${fails.length}`);
  for (const [r, n] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${r}: ${n}`);
  if (byBehavior.size) {
    console.log('  by behavior/model:');
    for (const [k, n] of [...byBehavior.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`    ${k}: ${n}`);
  }

  // ---------------------------------------------------------------
  // 3. Connector batch-classify calls. exa.ts batchExtractCompaniesDetailed and
  //    web.ts batchIdentifyCompanies send every result in ONE call and make the
  //    model echo each id back -- the shape the gate was fixed for. Only the
  //    latest run is retained per source, so this is current state, not history.
  // ---------------------------------------------------------------
  const sources = await pageAll<any>((f, t) => sb.from('sources')
    .select('id, workspace_id, connector_type, active, config, last_run_at, last_run_status, last_run_summary')
    .range(f, t));
  console.log('\n--- 3. connector batch-classify (latest run per source) ---');
  const batchy = sources.filter((s) => s.connector_type === 'exa' || s.connector_type === 'web');
  console.log(`exa/web sources: ${batchy.length} (${batchy.filter((s) => s.active).length} active)`);
  let flagged = 0;
  for (const s of batchy) {
    const errs: string[] = s.last_run_summary?.errors ?? [];
    const intent = s.config?.intent ?? '(unset)';
    const numResults = s.config?.num_results ?? (s.connector_type === 'exa' ? 25 : null);
    const bad = errs.filter((e) => /omitted|extraction failed|JSON|parse|unexpected/i.test(e));
    // discover mode is the one that runs the batch classifier at all.
    const runsClassifier = intent === 'discover';
    if (!runsClassifier && !bad.length) continue;
    flagged++;
    console.log(`  ${s.connector_type} ${String(s.id).slice(0, 8)} ws=${String(s.workspace_id).slice(0, 8)} active=${s.active} intent=${intent} num_results=${numResults} status=${s.last_run_status} last=${s.last_run_at?.slice(0, 16) ?? 'never'}`);
    if (bad.length) for (const e of bad) console.log(`      ERR ${e.slice(0, 160)}`);
    else if (errs.length) console.log(`      (other errors: ${errs.length})`);
  }
  if (!flagged) console.log('  no discover-mode exa/web sources and no parse errors on latest runs');

  // ---------------------------------------------------------------
  // 4. Did the 96h cadence land? Runs per account per day, by day.
  // ---------------------------------------------------------------
  console.log('\n--- 4. research cadence, by day ---');
  const perDayAccounts = new Map<string, Set<string>>();
  const perDaySearches = new Map<string, number>();
  const perDayKept = new Map<string, number>();
  for (const r of runs) {
    const day = r.created_at.slice(0, 10);
    if (!perDayAccounts.has(day)) perDayAccounts.set(day, new Set());
    if (r.target_id) perDayAccounts.get(day)!.add(r.target_id);
    perDaySearches.set(day, (perDaySearches.get(day) ?? 0) + (r.payload?.searches ?? 0));
    perDayKept.set(day, (perDayKept.get(day) ?? 0) + (r.payload?.results_created ?? 0));
  }
  console.log('day         runs  accts  runs/acct  searches  kept  kept/search');
  for (const [d, n] of [...runsByDay.entries()].sort().slice(-14)) {
    const accts = perDayAccounts.get(d)?.size ?? 0;
    const s = perDaySearches.get(d) ?? 0;
    const k = perDayKept.get(d) ?? 0;
    console.log(`${d}  ${String(n).padStart(4)}  ${String(accts).padStart(5)}  ${(accts ? n / accts : 0).toFixed(2).padStart(9)}  ${String(s).padStart(8)}  ${String(k).padStart(4)}  ${(s ? k / s : 0).toFixed(2).padStart(11)}`);
  }

  // Policy check: is tier_cadence_hours actually set / defaulting to 96?
  const wss = await pageAll<any>((f, t) => sb.from('workspaces').select('id, name, policy').range(f, t));
  console.log('\npolicy.research.tier_cadence_hours per workspace:');
  for (const w of wss) {
    const tc = w.policy?.research?.tier_cadence_hours;
    console.log(`  ${String(w.id).slice(0, 8)} ${w.name ?? ''}: ${tc ? JSON.stringify(tc) : '(unset -> code default)'}`);
  }
  console.log(`\nnote: ${pct(unreadable, runs.length)} of research runs had an unreadable gate batch`);
})();
