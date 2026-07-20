import { config } from 'dotenv'; config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { scoreEntity } from '@agent-crm/tools';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const ws='af602fa1-1e0b-4bee-9841-01894553e0a9';
const ids=['ed3f4443-acc6-4394-a4e1-ab94f90b66bf','d42c2b42-c5b4-40ef-8a26-2f0e9202a418','b92f4053-c6d2-4845-a20a-f6030a420533'];
(async()=>{
  for (const full of ids) {
    const { data: ent } = await sb.from('entities').select('id,name,attributes').eq('id',full).maybeSingle();
    const a=(ent?.attributes??{}) as any;
    const { data: isa } = await sb.from('facts').select('object_text').eq('subject_entity',full).eq('predicate','is_a').is('supersedes',null);
    const { data: drop } = await sb.from('facts').select('object_text').eq('subject_entity',full).eq('predicate','dropped_until').is('supersedes',null);
    const t0=Date.now();
    let res:any='?'; try{ res = await scoreEntity(sb, ws, full); }catch(e){ res='THREW: '+(e as Error).message; }
    console.log(`${ent?.name} (${full.slice(0,8)}) _candidate=${a._candidate} is_a=${JSON.stringify((isa??[]).map(r=>r.object_text))} dropped=${JSON.stringify((drop??[]).map(r=>r.object_text))}`);
    console.log(`   scoreEntity -> ${res===null?'NULL':typeof res==='string'?res:`icp_total=${res.icp_total?.toFixed(2)} llm_called=${res.llm_called}`} (${Date.now()-t0}ms)`);
  }
})();
