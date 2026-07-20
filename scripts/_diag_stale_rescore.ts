import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { isSubstantiveFact } from '@agent-crm/tools';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const ws = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
const now = Date.now();
const DAY = 86_400_000;
const cutoff = new Date(now - DAY).toISOString();

async function fetchAll<T>(q: (f: number, t: number) => any): Promise<T[]> {
  const out: T[] = []; let f = 0; const n = 1000;
  for (;;) { const { data, error } = await q(f, f + n - 1); if (error) throw error; const r = (data ?? []) as T[]; out.push(...r); if (r.length < n) break; f += n; }
  return out;
}

async function main() {
  const disp = await fetchAll<{ target_id: string | null; payload: any }>((f, t) => sb.from('events')
    .select('target_id, payload').eq('workspace_id', ws).eq('action', 'agent_dispatch_result').gte('created_at', cutoff).order('id').range(f, t));
  const ids = [...new Set(disp.filter((d) => d.payload?.behavior === 'enricher' && (d.payload?.facts_asserted ?? 0) > 0 && d.target_id).map((d) => d.target_id as string))];

  // icp_fit per entity
  const icp = await fetchAll<{ subject_entity: string; observed_at: string }>((f, t) => sb.from('facts')
    .select('subject_entity, observed_at').eq('workspace_id', ws).eq('predicate', 'icp_fit').is('supersedes', null).in('subject_entity', ids).order('id').range(f, t));
  const icpObs = new Map(icp.map((r) => [r.subject_entity, r.observed_at]));

  // stale = has icp_fit but observed < cutoff
  const stale = ids.filter((id) => { const o = icpObs.get(id); return o && o < cutoff; });
  console.log(`entities w/ new facts = ${ids.length}, stale-score subset = ${stale.length}`);

  // For each stale entity, newest substantive fact observed_at + created_at vs score observed_at
  let factsNewerByObserved = 0, factsNewerByCreated = 0, factsOlder = 0;
  const sample: string[] = [];
  for (const id of stale) {
    const facts = await fetchAll<{ predicate: string; observed_at: string; created_at: string }>((f, t) => sb.from('facts')
      .select('predicate, observed_at, created_at').eq('workspace_id', ws).eq('subject_entity', id).is('supersedes', null).order('observed_at', { ascending: false }).range(f, t));
    const subs = facts.filter((x) => isSubstantiveFact(x.predicate));
    const scoreObs = icpObs.get(id)!;
    const maxObs = subs.reduce((m, x) => x.observed_at > m ? x.observed_at : m, '');
    const maxCreated = subs.reduce((m, x) => x.created_at > m ? x.created_at : m, '');
    const obsNewer = maxObs > scoreObs;
    const createdNewer = maxCreated > scoreObs;
    if (obsNewer) factsNewerByObserved++;
    if (createdNewer) factsNewerByCreated++;
    if (!obsNewer) factsOlder++;
    if (sample.length < 8) sample.push(`${id.slice(0, 8)} score_obs=${scoreObs.slice(0, 19)} newestFact_obs=${maxObs.slice(0, 19)} newestFact_created=${maxCreated.slice(0, 19)} obsNewer=${obsNewer} createdNewer=${createdNewer}`);
  }
  console.log(`\nAmong stale-score entities (got new facts but score not refreshed):`);
  console.log(`  newest substantive fact OBSERVED_AT newer than score = ${factsNewerByObserved}`);
  console.log(`  newest substantive fact CREATED_AT  newer than score = ${factsNewerByCreated}`);
  console.log(`  newest fact observed_at NOT newer (backdated)         = ${factsOlder}`);
  console.log('\nsample:'); for (const s of sample) console.log('  ', s);
  console.log('\n=> If CREATED_AT is newer but OBSERVED_AT is not, the skip-when-stale guard');
  console.log('   (scoring.ts:226-240, compares observed_at) wrongly suppresses the rescore.');
}
main().catch((e) => { console.error(e); process.exit(1); });
