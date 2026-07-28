import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { fetchAll } from '@agent-crm/tools';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const DRY = process.argv.includes('--dry');
async function main() {
  const archived = await fetchAll<{id:string;workspace_id:string;attributes:any}>((from,to)=>
    sb.from('entities').select('id,workspace_id,attributes').not('archived_at','is',null).range(from,to) as any);
  const notMerged = archived.filter(e => !(e.attributes?._merged_into));
  const ids = notMerged.map(e=>e.id);
  const hasAct = new Set<string>();
  const CH=150;
  for (const [table,col] of [['facts','subject_entity'],['signals','entity_id']] as const) {
    for (let i=0;i<ids.length;i+=CH){
      const chunk=ids.slice(i,i+CH);
      const rows=await fetchAll<any>((from,to)=> sb.from(table).select(col).in(col,chunk).range(from,to) as any);
      for (const r of rows) if(r[col]) hasAct.add(r[col]);
    }
  }
  const wrong = notMerged.filter(e=>hasAct.has(e.id));
  const byWs: Record<string,number> = {};
  for (const e of wrong) byWs[e.workspace_id.slice(0,8)]=(byWs[e.workspace_id.slice(0,8)]??0)+1;
  console.log(`Wrongly archived (have facts/signals, not merged): ${wrong.length}`, JSON.stringify(byWs));
  if (DRY) { console.log('DRY RUN — no changes'); return; }
  const wrongIds = wrong.map(e=>e.id);
  let restored=0;
  for (let i=0;i<wrongIds.length;i+=200){
    const chunk=wrongIds.slice(i,i+200);
    const { error, count } = await sb.from('entities').update({ archived_at: null }, { count:'exact' }).in('id', chunk);
    if (error) { console.error('restore error:', error.message); process.exit(1); }
    restored += count ?? chunk.length;
  }
  console.log(`RESTORED (archived_at -> null): ${restored}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
