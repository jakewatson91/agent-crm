import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = process.env.WS || 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const DAYS = Number(process.env.DAYS || 30);
const since = new Date(Date.now() - DAYS * 86400e3).toISOString();

async function fetchAll(action: string) {
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from('events').select('payload, created_at')
      .eq('workspace_id', WS).eq('action', action).gte('created_at', since)
      .order('created_at', { ascending: true }).range(from, from + 999);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

async function main() {
  console.log(`\n=== SYSTEM YIELD AUDIT — ws ${WS.slice(0, 8)} — ${DAYS}d ===\n`);

  // A) Research-layer waste the system removed BEFORE any model extraction ran.
  const markers = await fetchAll('research_completed');
  let searches = 0, created = 0, filtered_out = 0, dupes = 0, stale = 0, url_dupes = 0, runs = 0;
  for (const e of markers) {
    const p = e.payload ?? {};
    if (typeof p.searches !== 'number') continue;
    runs++; searches += p.searches; created += (p.results_created ?? 0);
    filtered_out += (p.filtered_out ?? 0);
    dupes += (p.duplicates_dropped ?? 0);
    stale += (p.filtered_stale ?? 0);
    url_dupes += (p.same_url_dropped ?? 0);
  }
  const fetched = created + filtered_out + dupes + stale + url_dupes;
  console.log('A) Research layer (per marker payloads):');
  console.log(`   research runs:          ${runs}`);
  console.log(`   raw results fetched:    ${fetched}`);
  console.log(`   -> off-target dropped:  ${filtered_out} (relevance/same-name gate)`);
  console.log(`   -> stale dropped:       ${stale} (recency gate)`);
  console.log(`   -> same-URL dropped:    ${url_dupes}`);
  console.log(`   -> near-dup dropped:    ${dupes} (embedding)`);
  console.log(`   = signals kept:         ${created}  (${fetched ? (100 * created / fetched).toFixed(0) : '—'}% of fetched)`);
  console.log(`   waste removed pre-model:${fetched - created}  (${fetched ? (100 * (fetched - created) / fetched).toFixed(0) : '—'}%)`);

  // B) Model-extraction runs the system AVOIDED (dedup/coalesce/cooldown skips).
  const skips = await fetchAll('enrichment_skipped');
  const byReason = new Map<string, number>();
  for (const e of skips) {
    const r = (e.payload?.reason ?? 'other') as string;
    byReason.set(r, (byReason.get(r) ?? 0) + 1);
  }
  const metrics = await fetchAll('agent_run_metrics');
  let enricherRuns = 0;
  for (const e of metrics) if ((e.payload?.behavior) === 'enricher') enricherRuns++;
  const totalSkips = [...byReason.values()].reduce((a, b) => a + b, 0);
  console.log('\nB) Model-extraction layer:');
  console.log(`   enricher runs executed: ${enricherRuns}`);
  console.log(`   enricher runs SKIPPED:  ${totalSkips}`);
  for (const [r, n] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) console.log(`     - ${r.padEnd(24)} ${n}`);
  const wouldRun = enricherRuns + totalSkips;
  console.log(`   naive (no skip) would run: ${wouldRun}  → system ran ${wouldRun ? (100 * enricherRuns / wouldRun).toFixed(0) : '—'}% of that`);

  // C) The multiplier: raw research fetched -> model runs actually executed.
  console.log('\nC) End-to-end funnel (what the system spends model $ on):');
  console.log(`   raw results fetched:     ${fetched}`);
  console.log(`   signals kept:            ${created}`);
  console.log(`   model extractions run:   ${enricherRuns}`);
  if (fetched && enricherRuns) console.log(`   → 1 model run per ${(fetched / enricherRuns).toFixed(1)} raw results fetched`);
  console.log('');
}
main().catch((e) => { console.error(e); process.exit(1); });
