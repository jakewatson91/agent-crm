/**
 * Search-targeting measurement pass. Read-only, spends nothing.
 *
 * Splits the two bugs the v1 plan says must be told apart before anything is
 * fixed: pages thrown away because the page is about a DIFFERENT COMPANY
 * (identity) versus pages about the right company that answer nothing in the
 * brief (no_answer / relevance). Also reports runs that bought nothing at all,
 * and which angle each drop came from.
 */
import { config } from 'dotenv';
config({ path: '/Users/jakewatson/src/agent-crm/.env.local' });
import { createClient } from '@supabase/supabase-js';
import { fetchAll } from '@agent-crm/tools';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const DAYS = Number(process.argv[2] ?? 14);
const since = new Date(Date.now() - DAYS * 86400e3).toISOString();

type Row = { created_at: string; payload: any };

async function main() {
  const rows = await fetchAll<Row>((from, to) =>
    sb.from('events').select('created_at, payload')
      .eq('workspace_id', WS).eq('action', 'research_completed')
      .gte('created_at', since).order('created_at', { ascending: true }).range(from, to));

  const by = { identity: 0, substance: 0, relevance: 0, no_answer: 0, unreported: 0 };
  let searches = 0, fetched = 0, created = 0, filtered_out = 0;
  let no_name = 0, stale = 0, dupes = 0;
  let zeroResultRuns = 0, oneSearchRuns = 0, zeroFetchRuns = 0;
  const dropWhy: Record<string, number> = {};
  const dropByAngle: Record<string, { drops: number; identity: number }> = {};
  const fetchedByAngle: Record<string, number> = {};
  const keptByAngle: Record<string, number> = {};
  const runsByAngle: Record<string, number> = {};
  const resolvedDomains: Array<[string, string]> = [];

  for (const r of rows) {
    const p = r.payload ?? {};
    searches += p.searches ?? 0;
    created += p.results_created ?? 0;
    filtered_out += p.filtered_out ?? 0;
    no_name += p.filtered_no_name ?? 0;
    stale += p.filtered_stale ?? 0;
    dupes += (p.same_url_dropped ?? 0) + (p.duplicates_dropped ?? 0);
    for (const k of Object.keys(by)) by[k as keyof typeof by] += p.filtered_by?.[k] ?? 0;
    const paf = p.per_angle_fetched ?? {};
    let runFetched = 0;
    for (const [a, n] of Object.entries(paf)) {
      fetchedByAngle[a] = (fetchedByAngle[a] ?? 0) + (n as number);
      runsByAngle[a] = (runsByAngle[a] ?? 0) + 1;
      runFetched += n as number;
    }
    for (const [a, n] of Object.entries(p.per_angle ?? {})) keptByAngle[a] = (keptByAngle[a] ?? 0) + (n as number);
    fetched += runFetched;
    if ((p.results_created ?? 0) === 0) zeroResultRuns++;
    if ((p.searches ?? 0) <= 1) oneSearchRuns++;
    if (runFetched === 0) zeroFetchRuns++;
    if (p.domain_resolved !== undefined) resolvedDomains.push([r.created_at.slice(0, 10), p.domain_resolved ?? '(nothing safe)']);
    for (const d of p.drop_sample ?? []) {
      dropWhy[d.why] = (dropWhy[d.why] ?? 0) + 1;
      const e = (dropByAngle[d.angle] ??= { drops: 0, identity: 0 });
      e.drops++;
      if (/identity|different|same.?name|not about/i.test(d.why)) e.identity++;
    }
  }

  const dropped = Object.values(by).reduce((a, b) => a + b, 0);
  console.log(`\nSudden, last ${DAYS}d: ${rows.length} completed research runs, ${searches} searches, ${fetched} pages fetched, ${created} signals kept\n`);
  console.log('WHY PAGES WERE THROWN AWAY (gate breakdown, %s total):', dropped);
  for (const [k, v] of Object.entries(by).sort((a, b) => b[1] - a[1]))
    console.log(`  ${k.padEnd(12)} ${String(v).padStart(6)}  ${dropped ? ((v / dropped) * 100).toFixed(1) : '0'}%`);
  console.log(`\n  also dropped outside the gate: ${no_name} never named the company, ${stale} stale, ${dupes} duplicates`);

  console.log('\nPER ANGLE — runs it appeared in, pages bought, pages kept:');
  console.log(`  ${'angle'.padEnd(28)} ${'runs'.padStart(5)} ${'fetched'.padStart(8)} ${'kept'.padStart(6)}  keep%`);
  const angles = new Set([...Object.keys(fetchedByAngle), ...Object.keys(keptByAngle), ...Object.keys(runsByAngle)]);
  for (const a of [...angles].sort((x, y) => (fetchedByAngle[y] ?? 0) - (fetchedByAngle[x] ?? 0))) {
    const f = fetchedByAngle[a] ?? 0, k = keptByAngle[a] ?? 0, r = runsByAngle[a] ?? 0;
    console.log(`  ${a.padEnd(28)} ${String(r).padStart(5)} ${String(f).padStart(8)} ${String(k).padStart(6)}  ${f ? ((k / f) * 100).toFixed(1) : '—'}%`);
  }

  console.log('\nDROP REASONS, sampled (max 8 per run):');
  for (const [w, n] of Object.entries(dropWhy).sort((x, y) => y[1] - x[1]).slice(0, 12))
    console.log(`  ${String(n).padStart(5)}  ${w.slice(0, 100)}`);

  console.log('\nDROPS BY ANGLE (sampled):');
  for (const [a, e] of Object.entries(dropByAngle).sort((x, y) => y[1].drops - x[1].drops))
    console.log(`  ${a.padEnd(28)} ${String(e.drops).padStart(5)} drops, ${e.identity} wrong-company`);

  console.log(`\nRUN SHAPE: ${zeroResultRuns}/${rows.length} runs kept nothing (${((zeroResultRuns / rows.length) * 100).toFixed(0)}%), ${oneSearchRuns} ran <=1 search, ${zeroFetchRuns} fetched nothing at all`);
  console.log(`DOMAIN RESOLVER fired on ${resolvedDomains.length} runs; last 10:`, resolvedDomains.slice(-10).map((d) => d[1]).join(', '));
}
main().catch((e) => { console.error(e); process.exit(1); });
