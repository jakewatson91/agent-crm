import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { isSubstantiveFact } from '@agent-crm/tools';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const ws = 'af602fa1-1e0b-4bee-9841-01894553e0a9';

async function fetchAll<T>(q: (f: number, t: number) => any): Promise<T[]> {
  const o: T[] = []; let f = 0; const n = 1000;
  for (;;) { const { data, error } = await q(f, f + n - 1); if (error) throw error; const r = (data ?? []) as T[]; o.push(...r); if (r.length < n) break; f += n; }
  return o;
}
function chunk<T>(a: T[], n: number): T[][] { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }

async function main() {
  // all account entities (last is_a = account)
  const isa = await fetchAll<{ subject_entity: string; object_text: string }>((f, t) => sb.from('facts')
    .select('subject_entity, object_text').eq('workspace_id', ws).eq('predicate', 'is_a').is('supersedes', null).order('id').range(f, t));
  const acctIds = [...new Set(isa.filter((r) => r.object_text === 'account').map((r) => r.subject_entity))];

  // scored set
  const scored = await fetchAll<{ subject_entity: string }>((f, t) => sb.from('facts')
    .select('subject_entity').eq('workspace_id', ws).eq('predicate', 'icp_fit').is('supersedes', null).order('id').range(f, t));
  const scoredSet = new Set(scored.map((s) => s.subject_entity));
  const unscored = acctIds.filter((id) => !scoredSet.has(id));
  console.log(`accounts=${acctIds.length}  scored=${acctIds.length - unscored.length}  UNSCORED=${unscored.length}`);

  // substantive fact count per unscored entity
  const substByEnt = new Map<string, number>();
  for (const ids of chunk(unscored, 300)) {
    const facts = await fetchAll<{ subject_entity: string; predicate: string }>((f, t) => sb.from('facts')
      .select('subject_entity, predicate').eq('workspace_id', ws).is('supersedes', null).in('subject_entity', ids).order('id').range(f, t));
    for (const fct of facts) if (isSubstantiveFact(fct.predicate)) substByEnt.set(fct.subject_entity, (substByEnt.get(fct.subject_entity) ?? 0) + 1);
  }
  const withFacts = unscored.filter((id) => (substByEnt.get(id) ?? 0) >= 1);
  console.log(`\nof ${unscored.length} unscored accounts:`);
  console.log(`  have >= 1 substantive fact (SHOULD be scoreable) = ${withFacts.length}`);
  console.log(`  have 0 substantive facts (thin / never researched) = ${unscored.length - withFacts.length}`);

  // signals per unscored entity (do they have any inbound signal at all?)
  let withSignals = 0;
  const sigCount = new Map<string, number>();
  for (const ids of chunk(unscored, 300)) {
    const sigs = await fetchAll<{ entity_id: string }>((f, t) => sb.from('signals')
      .select('entity_id').eq('workspace_id', ws).in('entity_id', ids).order('id').range(f, t));
    for (const s of sigs) sigCount.set(s.entity_id, (sigCount.get(s.entity_id) ?? 0) + 1);
  }
  withSignals = unscored.filter((id) => (sigCount.get(id) ?? 0) > 0).length;
  console.log(`  have >= 1 signal = ${withSignals}   (0 signals = ${unscored.length - withSignals})`);

  // attributes shape + creation dates for a sample of the WITH-FACTS unscored (the real gap)
  const ents = await fetchAll<{ id: string; name: string; attributes: any; created_at: string }>((f, t) => sb.from('entities')
    .select('id, name, attributes, created_at').in('id', withFacts.slice(0, 1000)).order('id').range(f, t));
  console.log(`\nsample of unscored-but-has-facts accounts (the real gap, n=${withFacts.length}):`);
  for (const e of ents.slice(0, 15)) console.log(`  ${(e.name ?? '?').slice(0, 28).padEnd(28)} facts=${substByEnt.get(e.id)} created=${String(e.created_at).slice(0, 10)} attrKeys=${Object.keys(e.attributes ?? {}).join(',')}`);

  // creation month histogram of ALL unscored
  const allUn = await fetchAll<{ id: string; created_at: string }>((f, t) => sb.from('entities')
    .select('id, created_at').in('id', unscored.slice(0, 1000)).order('id').range(f, t));
  const byMonth = new Map<string, number>();
  for (const e of allUn) { const m = String(e.created_at).slice(0, 7); byMonth.set(m, (byMonth.get(m) ?? 0) + 1); }
  console.log('\ncreation month (first 1000 unscored):', JSON.stringify(Object.fromEntries([...byMonth].sort())));
}
main().catch((e) => { console.error(e); process.exit(1); });
