import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS='e7052848-2270-41ac-90b6-d9b75c87f6d3';
async function fetchAll(t:string,s:string,m:(q:any)=>any=q=>q){let o:any[]=[],f=0;for(;;){const{data,error}=await m(sb.from(t).select(s)).range(f,f+999);if(error){console.error(t,error.message);break;}o=o.concat(data??[]);if(!data||data.length<1000)break;f+=1000;}return o;}
async function main(){
  const e = await sb.from('entities').select('attributes').eq('workspace_id',WS).limit(3);
  console.log('sample attributes keys:', (e.data??[]).map((x:any)=>Object.keys(x.attributes??{}).join('|')));
  const facts = await fetchAll('facts','id,subject_entity,happened_at,created_at,supersedes',(q:any)=>q.eq('workspace_id',WS).gte('created_at','2026-08-15'));
  console.log('\nfacts created since 08-15:', facts.length, '| with happened_at:', facts.filter(f=>f.happened_at).length, `(${(facts.filter(f=>f.happened_at).length/Math.max(facts.length,1)*100).toFixed(1)}%)`);
  const live = facts.filter(f=>!f.supersedes);
  console.log('of those, non-superseding:', live.length);
  // per-day
  const byDay: Record<string,{n:number,d:number}> = {};
  for (const f of facts) { const k=f.created_at.slice(0,10); byDay[k]??={n:0,d:0}; byDay[k].n++; if(f.happened_at) byDay[k].d++; }
  console.log('facts/day, dated/day:'); for (const [k,v] of Object.entries(byDay).sort()) console.log('  ',k, v.n, v.d);
}
main();
