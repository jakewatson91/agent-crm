import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { isSubstantiveFact } from '@agent-crm/tools';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const ws = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
// "Real research evidence" = substantive AND not the type tag / bookkeeping.
const NOT_EVIDENCE = new Set(['is_a', 'domain']);
const isEvidence = (p: string) => isSubstantiveFact(p) && !NOT_EVIDENCE.has(p);

async function fetchAll<T>(q: (f: number, t: number) => any): Promise<T[]> {
  const o: T[] = []; let f = 0; const n = 1000;
  for (;;) { const { data, error } = await q(f, f + n - 1); if (error) throw error; const r = (data ?? []) as T[]; o.push(...r); if (r.length < n) break; f += n; }
  return o;
}
function chunk<T>(a: T[], n: number): T[][] { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }

async function main() {
  const isa = await fetchAll<{ subject_entity: string; object_text: string }>((f, t) => sb.from('facts')
    .select('subject_entity, object_text').eq('workspace_id', ws).eq('predicate', 'is_a').is('supersedes', null).order('id').range(f, t));
  const acctIds = [...new Set(isa.filter((r) => r.object_text === 'account').map((r) => r.subject_entity))];
  const scored = await fetchAll<{ subject_entity: string }>((f, t) => sb.from('facts')
    .select('subject_entity').eq('workspace_id', ws).eq('predicate', 'icp_fit').is('supersedes', null).order('id').range(f, t));
  const scoredSet = new Set(scored.map((s) => s.subject_entity));
  const unscored = acctIds.filter((id) => !scoredSet.has(id));

  const evCount = new Map<string, number>();
  for (const ids of chunk(unscored, 150)) {
    const facts = await fetchAll<{ subject_entity: string; predicate: string }>((f, t) => sb.from('facts')
      .select('subject_entity, predicate').eq('workspace_id', ws).is('supersedes', null).in('subject_entity', ids).order('id').range(f, t));
    for (const fct of facts) if (isEvidence(fct.predicate)) evCount.set(fct.subject_entity, (evCount.get(fct.subject_entity) ?? 0) + 1);
  }
  const withEvidence = unscored.filter((id) => (evCount.get(id) ?? 0) >= 1);
  const sigCount = new Map<string, number>();
  for (const ids of chunk(unscored, 150)) {
    const sigs = await fetchAll<{ entity_id: string }>((f, t) => sb.from('signals')
      .select('entity_id').eq('workspace_id', ws).in('entity_id', ids).order('id').range(f, t));
    for (const s of sigs) sigCount.set(s.entity_id, (sigCount.get(s.entity_id) ?? 0) + 1);
  }
  const withSig = unscored.filter((id) => (sigCount.get(id) ?? 0) > 0);
  console.log(`UNSCORED accounts = ${unscored.length}`);
  console.log(`  with real research evidence (excl is_a/domain) = ${withEvidence.length}   <-- genuine scoring gap`);
  console.log(`  thin (only is_a/domain, never researched)      = ${unscored.length - withEvidence.length}  <-- expected unscored`);
  console.log(`  with >=1 signal                                = ${withSig.length}`);

  // The real gap = has evidence but no score. Were they ever enriched?
  const gap = withEvidence;
  const gapSet = new Set(gap);
  let enrichedGap = 0;
  const disp = await fetchAll<{ target_id: string | null; payload: any }>((f, t) => sb.from('events')
    .select('target_id, payload').eq('workspace_id', ws).eq('action', 'agent_dispatch_result').order('id').range(f, t));
  const enrichedEnts = new Set(disp.filter((d) => d.payload?.behavior === 'enricher' && (d.payload?.facts_asserted ?? 0) > 0 && d.target_id).map((d) => d.target_id as string));
  for (const id of gap) if (enrichedEnts.has(id)) enrichedGap += 1;
  console.log(`\nof the ${gap.length} with-evidence-but-unscored:`);
  console.log(`  were enriched at some point (facts_asserted>0 dispatch exists) = ${enrichedGap}`);
  console.log(`  never enriched (evidence came from elsewhere / import)         = ${gap.length - enrichedGap}`);

  // sample names + when created + attr shape
  const sample = await fetchAll<{ id: string; name: string; attributes: any; created_at: string }>((f, t) => sb.from('entities')
    .select('id, name, attributes, created_at').in('id', gap.slice(0, 120)).order('id').range(f, t));
  console.log('\nsample (with-evidence-but-unscored):');
  for (const e of sample.slice(0, 18)) console.log(`  ${(e.name ?? '?').slice(0, 26).padEnd(26)} ev=${evCount.get(e.id)} sig=${sigCount.get(e.id) ?? 0} enr=${enrichedEnts.has(e.id)} created=${String(e.created_at).slice(0, 10)} attrs=${Object.keys(e.attributes ?? {}).join(',')}`);

  const byMonth = new Map<string, number>();
  for (const e of sample) { const m = String(e.created_at).slice(0, 7); byMonth.set(m, (byMonth.get(m) ?? 0) + 1); }
  console.log('\ncreated month (sample):', JSON.stringify(Object.fromEntries([...byMonth].sort())));
}
main().catch((e) => { console.error(e); process.exit(1); });
