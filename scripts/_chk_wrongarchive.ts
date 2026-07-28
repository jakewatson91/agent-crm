import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { fetchAll } from '@agent-crm/tools';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function main() {
  // All archived entities (all workspaces), not merged
  const archived = await fetchAll<{id:string;workspace_id:string;name:string;attributes:any}>((from,to)=>
    sb.from('entities').select('id,workspace_id,name,attributes').not('archived_at','is',null).range(from,to) as any);
  const notMerged = archived.filter(e => !(e.attributes?._merged_into));
  console.log(`Total archived (not merged): ${notMerged.length}`);
  // Which of those have facts or signals -> wrongly archived
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
  for (const e of wrong) byWs[e.workspace_id.slice(0,8)] = (byWs[e.workspace_id.slice(0,8)]??0)+1;
  console.log(`WRONGLY archived (have facts/signals): ${wrong.length}`);
  console.log('by workspace:', JSON.stringify(byWs));
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
