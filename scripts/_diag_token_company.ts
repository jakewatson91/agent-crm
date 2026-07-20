import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { ADMIN_PREDICATES } from '../packages/tools/src/scoring.ts';

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const ws = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
  const ent = await sb.from('entities').select('id,name,attributes')
    .eq('workspace_id', ws).ilike('name', '%token company%');
  if (!ent.data?.length) { console.log('no entity'); return; }
  for (const e of ent.data) {
    console.log(`\n=== ${e.name}  (${e.id}) ===`);
    const fr = await sb.from('facts')
      .select('id,predicate,object_text,confidence,observed_at,created_at,supersedes')
      .eq('workspace_id', ws).eq('subject_entity', e.id)
      .order('observed_at', { ascending: false });
    const raw = fr.data ?? [];
    const supersededIds = new Set(raw.map((f: any) => f.supersedes).filter(Boolean));
    const active = raw.filter((f: any) => !supersededIds.has(f.id));
    const substantive = active.filter((f: any) => !ADMIN_PREDICATES.has(f.predicate));

    console.log(`raw facts=${raw.length}  active(non-superseded)=${active.length}  substantive(non-admin)=${substantive.length}`);
    console.log(`-> evidence_depth = min(1, ${substantive.length}/6) = ${Math.min(1, substantive.length/6).toFixed(2)}`);
    console.log('\nSUBSTANTIVE facts (drive evidence_depth):');
    for (const f of substantive) {
      console.log(`  [${f.predicate}] = ${String(f.object_text).slice(0,80)}  (conf ${f.confidence}, ${f.observed_at?.slice(0,10)})`);
    }
    console.log('\nADMIN/score facts (excluded):');
    for (const f of active.filter((f: any) => ADMIN_PREDICATES.has(f.predicate))) {
      console.log(`  [${f.predicate}] = ${String(f.object_text).slice(0,60)}`);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
