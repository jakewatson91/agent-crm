/**
 * Read-only: what the relevance gate has actually been rejecting, from the
 * research_completed markers already in the event log. No Exa spend.
 *
 * Usage: tsx scripts/_chk_filter_breakdown.ts [days]   (default 7)
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const DAYS = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 7);

async function main() {
  const sb = createServerClient();
  const since = new Date(Date.now() - DAYS * 86400 * 1000).toISOString();
  const { data, error } = await sb.from('events')
    .select('created_at, target_id, payload')
    .eq('workspace_id', WS)
    .eq('action', 'research_completed')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) { console.error(error); return; }
  const rows = (data ?? []) as Array<{ created_at: string; target_id: string; payload: any }>;
  if (!rows.length) { console.log(`no research_completed markers in the last ${DAYS}d`); return; }

  const names = new Map<string, string>();
  const ids = [...new Set(rows.map((r) => r.target_id))];
  for (let i = 0; i < ids.length; i += 100) {
    const { data: es } = await sb.from('entities').select('id, name').in('id', ids.slice(i, i + 100));
    for (const e of (es ?? []) as Array<{ id: string; name: string }>) names.set(e.id, e.name);
  }

  const tot = { created: 0, searches: 0, filtered_out: 0, stale: 0, dup: 0,
                identity: 0, substance: 0, relevance: 0, unreported: 0, runs: 0, withBreakdown: 0 };
  console.log(`run                          created  filt  ident  subst   relev  unrep  stale`);
  for (const r of rows) {
    const p = r.payload ?? {};
    const b = p.filtered_by ?? null;
    tot.runs++;
    tot.created += p.results_created ?? 0;
    tot.searches += p.searches ?? 0;
    tot.filtered_out += p.filtered_out ?? 0;
    tot.stale += p.filtered_stale ?? 0;
    tot.dup += (p.same_url_dropped ?? 0) + (p.duplicates_dropped ?? 0);
    if (b) {
      tot.withBreakdown++;
      tot.identity += b.identity ?? 0; tot.substance += b.substance ?? 0;
      tot.relevance += b.relevance ?? 0; tot.unreported += b.unreported ?? 0;
    }
    const nm = (names.get(r.target_id) ?? r.target_id).slice(0, 22).padEnd(22);
    const d = r.created_at.slice(5, 10);
    console.log(`${d} ${nm} ${String(p.results_created ?? 0).padStart(6)}${String(p.filtered_out ?? 0).padStart(6)}` +
      (b ? `${String(b.identity ?? 0).padStart(7)}${String(b.substance ?? 0).padStart(7)}${String(b.relevance ?? 0).padStart(8)}${String(b.unreported ?? 0).padStart(7)}` : `      (no breakdown)      `) +
      `${String(p.filtered_stale ?? 0).padStart(7)}`);
  }

  console.log(`\n--- ${tot.runs} runs, ${tot.withBreakdown} with a per-test breakdown ---`);
  console.log(`searches ${tot.searches}   signals created ${tot.created}   filtered_out ${tot.filtered_out}   stale ${tot.stale}   dup ${tot.dup}`);
  const den = tot.identity + tot.substance + tot.relevance + tot.unreported;
  if (den) {
    const pct = (n: number) => `${n} (${((n / den) * 100).toFixed(0)}%)`;
    console.log(`drops by test: identity ${pct(tot.identity)}  substance ${pct(tot.substance)}  relevance ${pct(tot.relevance)}  unreported ${pct(tot.unreported)}`);
  } else {
    console.log('no per-test breakdown recorded yet (runs predate the droppedBy instrumentation)');
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
