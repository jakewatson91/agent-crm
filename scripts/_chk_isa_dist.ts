import { config } from 'dotenv'; config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const ws='af602fa1-1e0b-4bee-9841-01894553e0a9';
async function fetchAll<T>(q:(f:number,t:number)=>any):Promise<T[]>{const o:T[]=[];let f=0;const n=1000;for(;;){const{data}=await q(f,f+n-1);const r=(data??[]) as T[];o.push(...r);if(r.length<n)break;f+=n;}return o;}
(async()=>{
  const isa = await fetchAll<{subject_entity:string;object_text:string}>((f,t)=>sb.from('facts').select('subject_entity,object_text').eq('workspace_id',ws).eq('predicate','is_a').is('supersedes',null).order('id').range(f,t));
  // last is_a per entity
  const byEnt=new Map<string,string>();
  for(const r of isa) byEnt.set(r.subject_entity, r.object_text);
  const dist=new Map<string,number>();
  for(const v of byEnt.values()) dist.set(v,(dist.get(v)??0)+1);
  console.log('is_a distribution across entities:');
  for(const [k,v] of [...dist].sort((a,b)=>b[1]-a[1])) console.log(`  ${k.padEnd(14)} ${v}`);
  // how many accounts got a score vs not
  const accts=[...byEnt].filter(([,v])=>v==='account').map(([e])=>e);
  const scored = await fetchAll<{subject_entity:string}>((f,t)=>sb.from('facts').select('subject_entity').eq('workspace_id',ws).eq('predicate','icp_fit').is('supersedes',null).order('id').range(f,t));
  const scoredSet=new Set(scored.map(s=>s.subject_entity));
  const acctScored=accts.filter(e=>scoredSet.has(e)).length;
  console.log(`\naccounts: ${accts.length}, of which have an icp_fit = ${acctScored}, unscored accounts = ${accts.length-acctScored}`);
})();
