import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS='e7052848-2270-41ac-90b6-d9b75c87f6d3';
async function fetchAll(t:string,s:string,m:(q:any)=>any=q=>q){let o:any[]=[],f=0;for(;;){const{data,error}=await m(sb.from(t).select(s)).range(f,f+999);if(error){console.error(t,error.message);break;}o=o.concat(data??[]);if(!data||data.length<1000)break;f+=1000;}return o;}
async function main(){
  const ents = await fetchAll('entities','id,name,is_a,archived_at,attributes,created_at',(q:any)=>q.eq('workspace_id',WS));
  const accounts = ents.filter(e=>e.is_a==='account');
  const live = accounts.filter(e=>!e.archived_at);
  console.log('entities', ents.length, '| accounts', accounts.length, '| live accounts', live.length, '| contacts', ents.filter(e=>e.is_a==='contact').length);
  // facts with happened_at fresh
  const facts = await fetchAll('facts','id,entity_id,happened_at,created_at,supersedes,predicate',(q:any)=>q.eq('workspace_id',WS));
  console.log('facts', facts.length);
  const now = Date.now();
  const fresh = facts.filter(f=>f.happened_at && (now - Date.parse(f.happened_at)) < 30*864e5);
  const freshEnts = new Set(fresh.map(f=>f.entity_id));
  console.log('facts with happened_at:', facts.filter(f=>f.happened_at).length, '| dated inside 30d:', fresh.length, '| accounts holding one:', freshEnts.size);
  const withAnyFact = new Set(facts.map(f=>f.entity_id));
  console.log('accounts with ANY fact:', [...withAnyFact].filter(id=>live.some(a=>a.id===id)).length);
  // predicates of fresh facts
  const pred: Record<string,number> = {};
  for (const f of fresh) pred[f.predicate]=(pred[f.predicate]??0)+1;
  console.log('\nfresh-fact predicates:', Object.entries(pred).sort((a,b)=>b[1]-a[1]).slice(0,15));
}
main();
