import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const ws = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
const since24 = new Date(Date.now() - 86_400_000).toISOString();

async function fetchAll<T>(q: (f: number, t: number) => any): Promise<T[]> {
  const out: T[] = []; let f = 0; const size = 1000;
  for (;;) { const { data, error } = await q(f, f + size - 1); if (error) throw error; const rows = (data ?? []) as T[]; out.push(...rows); if (rows.length < size) break; f += size; }
  return out;
}

async function main() {
  // uncapped candidate count
  const allEnts = await fetchAll<{ id: string; attributes: any }>((f, t) => sb.from('entities')
    .select('id, attributes').eq('workspace_id', ws).order('id').range(f, t));
  const candIds = new Set(allEnts.filter((e) => e.attributes?._candidate === true).map((e) => e.id));
  console.log(`entities total = ${allEnts.length}  |  _candidate = ${candIds.size} (${(100 * candIds.size / allEnts.length).toFixed(0)}%)`);

  // enricher dispatches in 24h, candidate vs full
  const disp = await fetchAll<{ target_id: string | null; payload: any }>((f, t) => sb.from('events')
    .select('target_id, payload').eq('workspace_id', ws).eq('action', 'agent_dispatch_result')
    .gte('created_at', since24).order('id').range(f, t));
  const enr = disp.filter((d) => d.payload?.behavior === 'enricher');
  let candRuns = 0, fullRuns = 0;
  const candEntsHit = new Set<string>(), fullEntsHit = new Set<string>();
  for (const d of enr) {
    if (d.target_id && candIds.has(d.target_id)) { candRuns += 1; candEntsHit.add(d.target_id); }
    else { fullRuns += 1; if (d.target_id) fullEntsHit.add(d.target_id); }
  }
  console.log(`\nenricher dispatches 24h = ${enr.length}`);
  console.log(`  on _candidate entities = ${candRuns} (${(100 * candRuns / Math.max(1, enr.length)).toFixed(0)}%)  across ${candEntsHit.size} candidates`);
  console.log(`  on full entities       = ${fullRuns} (${(100 * fullRuns / Math.max(1, enr.length)).toFixed(0)}%)  across ${fullEntsHit.size} entities`);
  console.log(`\n=> ~${(100 * candRuns / Math.max(1, enr.length)).toFixed(0)}% of enricher runs (of the 11.1M tok/day) went to entities the scorer refuses to score.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
