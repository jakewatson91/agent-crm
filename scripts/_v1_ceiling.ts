import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { loadBestContactScore } from '@agent-crm/tools';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function fetchAll(t:string,c:string,ap:(q:any)=>any){const P=1000;let o:any[]=[];for(let f=0;;f+=P){const{data,error}=await ap(sb.from(t).select(c)).range(f,f+P-1);if(error)throw new Error(error.message);o.push(...(data??[]));if(!data||data.length<P)break;}return o;}
async function main(){
  const ws=((await sb.from('workspaces').select('id')).data??[]).find((w:any)=>(w.id as string).startsWith('af602fa1'))!.id as string;
  // last event = is run still advancing?
  const last=(await sb.from('events').select('action,created_at').eq('workspace_id',ws).order('created_at',{ascending:false}).limit(1).maybeSingle()).data;
  console.log('last event:', last?.created_at, last?.action, '| now:', new Date().toISOString());
  // qualified accounts
  const sr=await fetchAll('facts','id,subject_entity,predicate,object_text,supersedes',(q)=>q.eq('workspace_id',ws).in('predicate',['score_total','score_signal_strength','score_evidence_depth']));
  const ptd=new Set(sr.map((r:any)=>r.supersedes).filter(Boolean));const cur:Record<string,any>={};
  for(const r of sr){if(ptd.has(r.id))continue;const e=cur[r.subject_entity]??={};const v=parseFloat(r.object_text);if(r.predicate==='score_total')e.tot=v;if(r.predicate==='score_signal_strength')e.sig=v;if(r.predicate==='score_evidence_depth')e.ev=v;}
  const gate=Object.entries(cur).filter(([_,e]:any)=>e.tot>=0.65&&e.sig>=0.70&&e.ev>=0.50).map(([id])=>id);
  console.log('qualified (clear 3 gates):', gate.length);
  // has a domain?
  const ents=await fetchAll('entities','id,name,attributes',(q)=>q.eq('workspace_id',ws).in('id',gate.slice(0,0).length?[]:gate));
  const byId=new Map(ents.map((e:any)=>[e.id,e]));
  let hasContact=0, hasDomainNoContact=0, noDomain=0;
  for(const id of gate){
    const best=await loadBestContactScore(sb,ws,id);
    if(best!==undefined&&best>=0.5){hasContact++;continue;}
    const dom=(byId.get(id)?.attributes as any)?.domain;
    if(dom)hasDomainNoContact++; else noDomain++;
  }
  console.log(`  draft-ready NOW (contact>=0.5): ${hasContact}`);
  console.log(`  pullable (domain, no contact):  ${hasDomainNoContact}`);
  console.log(`  no domain (dead end):           ${noDomain}`);
}
main().catch(e=>{console.error(e);process.exit(1);});
