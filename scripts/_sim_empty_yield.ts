/**
 * Given the last N runs on an account all found nothing, what does the NEXT run
 * find? Sets the empty-run backoff trigger from history instead of a guess.
 *
 * Reads only. Usage: pnpm tsx scripts/_sim_empty_yield.ts [--days 90]
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const argv = process.argv.slice(2);
let DAYS = 90; for (let i = 0; i < argv.length; i++) if (argv[i] === '--days') DAYS = Number(argv[++i]) || DAYS;
const since = new Date(Date.now() - DAYS * 86400e3).toISOString();

(async () => {
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('events').select('target_id, created_at, payload')
      .eq('workspace_id', WS).eq('action', 'research_completed').eq('target_kind', 'entity')
      .gte('created_at', since).order('created_at', { ascending: true }).range(from, from + 999);
    if (error) throw error;
    if (!data?.length) break;
    rows.push(...data); if (data.length < 1000) break;
  }
  const byEntity = new Map<string, Array<{ created: number; searches: number }>>();
  for (const r of rows) {
    const l = byEntity.get(r.target_id) ?? [];
    l.push({ created: Number(r.payload?.results_created ?? 0) || 0, searches: Number(r.payload?.searches ?? 0) || 0 });
    byEntity.set(r.target_id, l);
  }
  // bucket each run by how many CONSECUTIVE empty runs preceded it on that account
  const buckets = new Map<number, { runs: number; produced: number; facts: number; searches: number }>();
  for (const runs of byEntity.values()) {
    let streak = 0;
    for (const r of runs) {
      const key = Math.min(streak, 4);
      const b = buckets.get(key) ?? { runs: 0, produced: 0, facts: 0, searches: 0 };
      b.runs++; b.searches += r.searches; b.facts += r.created; if (r.created > 0) b.produced++;
      buckets.set(key, b);
      streak = r.created > 0 ? 0 : streak + 1;
    }
  }
  console.log(`${rows.length} research runs over ${byEntity.size} accounts, last ${DAYS}d\n`);
  console.log('prior consecutive   runs   % that found   facts   searches   facts per');
  console.log('empty runs                 something               spent      search');
  for (const [k, b] of [...buckets].sort((a, b2) => a[0] - b2[0])) {
    const label = k === 4 ? '4+' : String(k);
    console.log(`  ${label.padEnd(16)} ${String(b.runs).padStart(5)}   ${(100*b.produced/b.runs).toFixed(0).padStart(11)}%   ${String(b.facts).padStart(5)}   ${String(b.searches).padStart(8)}   ${(b.facts/Math.max(b.searches,1)).toFixed(2).padStart(9)}`);
  }
  const b0 = buckets.get(0)!;
  console.log(`\nbaseline (no prior empty run): ${(100*b0.produced/b0.runs).toFixed(0)}% of runs find something, ${(b0.facts/Math.max(b0.searches,1)).toFixed(2)} facts/search`);
})();
