import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const ws = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
const now = Date.now();
const DAY = 86_400_000;
const since24 = new Date(now - DAY).toISOString();

async function fetchAll<T>(q: (f: number, t: number) => any): Promise<T[]> {
  const out: T[] = []; let f = 0; const size = 1000;
  for (;;) { const { data, error } = await q(f, f + size - 1); if (error) throw error; const rows = (data ?? []) as T[]; out.push(...rows); if (rows.length < size) break; f += size; }
  return out;
}

async function main() {
  // ---- (1) enricher dispatch concentration: which entities eat the 817 runs? ----
  const disp = await fetchAll<{ target_id: string | null; payload: any }>((f, t) => sb.from('events')
    .select('target_id, payload').eq('workspace_id', ws).eq('action', 'agent_dispatch_result')
    .gte('created_at', since24).order('id').range(f, t));
  const enr = disp.filter((d) => d.payload?.behavior === 'enricher');
  const perEnt = new Map<string, { runs: number; facts: number }>();
  for (const d of enr) {
    const id = d.target_id ?? '(null)';
    const r = perEnt.get(id) ?? { runs: 0, facts: 0 };
    r.runs += 1; r.facts += d.payload?.facts_asserted ?? 0; perEnt.set(id, r);
  }
  console.log(`enricher dispatch results in 24h = ${enr.length}  (distinct entities = ${perEnt.size})`);
  const top = [...perEnt].sort((a, b) => b[1].runs - a[1].runs).slice(0, 12);
  console.log('top entities by enricher dispatches:');
  for (const [id, r] of top) console.log(`  ${id.slice(0, 8)}  runs=${String(r.runs).padStart(4)}  facts_asserted_total=${r.facts}`);
  const runsArr = [...perEnt.values()].map((r) => r.runs).sort((a, b) => b - a);
  const top5runs = runsArr.slice(0, 5).reduce((a, b) => a + b, 0);
  console.log(`top 5 entities account for ${top5runs}/${enr.length} dispatches (${(100 * top5runs / Math.max(1, enr.length)).toFixed(0)}%)`);

  // ---- (2) coupling false-alarm check: created_at vs observed_at on icp_fit ----
  const entitiesWithNewFacts = new Set<string>();
  for (const d of enr) if ((d.payload?.facts_asserted ?? 0) > 0 && d.target_id) entitiesWithNewFacts.add(d.target_id);
  const ids = [...entitiesWithNewFacts];
  const icp = await fetchAll<{ subject_entity: string; observed_at: string; created_at: string }>((f, t) => sb.from('facts')
    .select('subject_entity, observed_at, created_at').eq('workspace_id', ws).eq('predicate', 'icp_fit')
    .is('supersedes', null).in('subject_entity', ids).order('id').range(f, t));
  const icpByEnt = new Map(icp.map((r) => [r.subject_entity, r]));
  let freshByCreated = 0, freshByObserved = 0, hasIcp = 0, noIcp = 0;
  const mism: string[] = [];
  for (const id of ids) {
    const r = icpByEnt.get(id);
    if (!r) { noIcp += 1; continue; }
    hasIcp += 1;
    const cFresh = r.created_at >= since24;
    const oFresh = r.observed_at >= since24;
    if (cFresh) freshByCreated += 1;
    if (oFresh) freshByObserved += 1;
    if (cFresh && !oFresh && mism.length < 10) mism.push(`${id.slice(0, 8)} created=${r.created_at.slice(0, 19)} observed=${r.observed_at.slice(0, 19)}`);
  }
  console.log(`\nof ${ids.length} entities with new facts:`);
  console.log(`  have a current icp_fit fact     = ${hasIcp}   (no icp_fit at all = ${noIcp})`);
  console.log(`  icp_fit CREATED  in last 24h    = ${freshByCreated}  <-- did the rescore actually run?`);
  console.log(`  icp_fit OBSERVED in last 24h    = ${freshByObserved}  <-- what the sweep measures`);
  console.log(`  rescored-but-observed_at-stale  = ${mism.length ? mism.length + '+' : 0}  (false-alarm signature)`);
  for (const m of mism) console.log('    ', m);
}
main().catch((e) => { console.error(e); process.exit(1); });
