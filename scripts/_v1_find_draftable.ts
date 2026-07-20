import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { loadBestContactScore } from '@agent-crm/tools';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

async function fetchAll(table:string,cols:string,apply:(q:any)=>any){const P=1000;let o:any[]=[];for(let f=0;;f+=P){const{data,error}=await apply(sb.from(table).select(cols)).range(f,f+P-1);if(error)throw new Error(error.message);o.push(...(data??[]));if(!data||data.length<P)break;}return o;}

async function main(){
  const ws=((await sb.from('workspaces').select('id')).data??[]).find(w=>(w.id as string).startsWith('af602fa1'))!.id as string;
  // current scores
  const sr=await fetchAll('facts','id,subject_entity,predicate,object_text,supersedes',(q)=>q.eq('workspace_id',ws).in('predicate',['score_total','score_signal_strength','score_evidence_depth']));
  const ptd=new Set(sr.map(r=>r.supersedes).filter(Boolean));const cur:Record<string,any>={};
  for(const r of sr){if(ptd.has(r.id))continue;const e=cur[r.subject_entity]??={};const v=parseFloat(r.object_text);if(r.predicate==='score_total')e.tot=v;if(r.predicate==='score_signal_strength')e.sig=v;if(r.predicate==='score_evidence_depth')e.ev=v;}
  const gate=Object.entries(cur).filter(([_,e]:any)=>e.tot>=0.65&&e.sig>=0.70&&e.ev>=0.50).map(([id,e])=>({id,...(e as any)}));
  // which have a buying_signal / recent_event / pain_observed hook fact (current)?
  const gateIds=new Set(gate.map(g=>g.id));
  const hookRows=await fetchAll('facts','subject_entity,predicate,object_text,supersedes,id',(q)=>q.eq('workspace_id',ws).in('predicate',['buying_signal','recent_event','pain_observed','hiring_role']));
  const hptd=new Set(hookRows.map(r=>r.supersedes).filter(Boolean));
  const hookByEnt=new Map<string,any[]>();
  for(const r of hookRows){if(hptd.has(r.id))continue;if(!gateIds.has(r.subject_entity))continue;const a=hookByEnt.get(r.subject_entity)??[];a.push(r);hookByEnt.set(r.subject_entity,a);}
  console.log(`qualified=${gate.length}, of which have a hook fact=${hookByEnt.size}`);
  // rank by score, check contact + domain, print top 12
  const ranked=gate.filter(g=>hookByEnt.has(g.id)).sort((a,b)=>b.tot-a.tot).slice(0,12);
  let withContact=0, withDomainNoContact=0;
  for(const g of ranked){
    const ent=(await sb.from('entities').select('name,attributes').eq('id',g.id).maybeSingle()).data;
    const best=await loadBestContactScore(sb,ws,g.id);
    if(best!==undefined&&best>=0.5)withContact++; else if((ent?.attributes as any)?.domain)withDomainNoContact++;
    const hooks=(hookByEnt.get(g.id)??[]).map(h=>h.predicate).join(',');
    console.log(`  ${(ent?.name??'?').padEnd(16)} tot=${g.tot.toFixed(2)} contact=${best===undefined?'none':best.toFixed(2)} domain=${(ent?.attributes as any)?.domain??'-'} hooks=[${hooks}] id=${g.id.slice(0,8)}`);
  }
  console.log(`\ntop12: withScoredContact>=.5=${withContact}, withDomain(pullable)NoContact=${withDomainNoContact}`);
}
main().catch(e=>{console.error(e);process.exit(1);});
