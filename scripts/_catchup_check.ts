import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS='af602fa1-1e0b-4bee-9841-01894553e0a9';
const now=Date.now();
async function cnt(mins:number){ const since=new Date(now-mins*60000).toISOString(); const r=await sb.from('facts').select('id',{head:true,count:'exact'}).eq('workspace_id',WS).gte('created_at',since); return r.count; }
(async()=>{
  console.log('facts last 15m:', await cnt(15));
  console.log('facts last 60m:', await cnt(60));
  console.log('facts last 180m:', await cnt(180));
  // last 2h: predicate mix + distinct entities
  const since=new Date(now-120*60000).toISOString();
  const f=await sb.from('facts').select('predicate, subject_entity_id').eq('workspace_id',WS).gte('created_at',since).limit(2000);
  const pred:Record<string,number>={}; const ents=new Set<string>();
  for(const x of f.data??[]){ pred[x.predicate as string]=(pred[x.predicate as string]??0)+1; if(x.subject_entity_id) ents.add(x.subject_entity_id as string); }
  console.log('\nlast 2h predicate mix:', pred);
  console.log('distinct entities touched last 2h:', ents.size);
})();
