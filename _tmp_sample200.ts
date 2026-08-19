/**
 * TEMP (delete after). Does the 15% fresh-event rate hold on accounts the
 * dispatcher has never reached? Research only, no enrichment: published_at is
 * stamped at research time, so no facts are written into the workspace.
 * SPENDS EXA: ~4 searches per account.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
import { runEntityResearch } from './inngest/functions/research.ts';
const sb = createServerClient();
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const N = Number(process.argv[2] ?? 200);
const ANGLES = 4;
const CONC = 3;
async function fetchAll(t:string,c:string,ap:(q:any)=>any){const P=1000;let o:any[]=[];for(let f=0;;f+=P){const{data,error}=await ap((sb as any).from(t).select(c)).range(f,f+P-1);if(error)throw new Error(error.message);o.push(...(data??[]));if(!data||data.length<P)break;}return o;}

async function main(){
  const isa = await fetchAll('facts','subject_entity,object_text,id,supersedes',(q)=>q.eq('workspace_id',WS).eq('predicate','is_a'));
  const ptd=new Set(isa.map((r:any)=>r.supersedes).filter(Boolean));
  const accts=new Set(isa.filter((r:any)=>!ptd.has(r.id)&&r.object_text==='account').map((r:any)=>r.subject_entity));
  const ents=await fetchAll('entities','id,name,archived_at,attributes',(q)=>q.eq('workspace_id',WS));
  const ev=await fetchAll('events','target_id',(q)=>q.eq('workspace_id',WS).in('action',['research_triggered','research_completed']));
  const done=new Set(ev.map((e:any)=>e.target_id));
  const pool=ents.filter((e:any)=>accts.has(e.id)&&!e.archived_at&&!done.has(e.id)&&(e.attributes as any)?.domain);
  // deterministic shuffle so a rerun picks the same set
  let seed=42; const rnd=()=>{seed=(seed*1664525+1013904223)>>>0; return seed/4294967296;};
  const shuffled=[...pool].sort(()=>rnd()-0.5).slice(0,N);
  console.log(`pool ${pool.length} never-researched-with-domain, sampling ${shuffled.length}, ${ANGLES} angles each\n`);

  const startedAt=new Date().toISOString();
  let done_=0, searches=0, kept=0, errs=0;
  const q=[...shuffled];
  await Promise.all(Array.from({length:CONC},async()=>{
    while(q.length){
      const e=q.shift()!; 
      try{
        const r:any = await runEntityResearch(sb,{workspace_id:WS,entity_id:e.id,entity_name:e.name,reason:'manual:tail_sample',angle_count:ANGLES,kind:'account'} as any);
        if(r?.ok===false){errs++; console.log(`  !! ${e.name}: ${r.reason}`); if(String(r.reason).includes('paused')||String(r.reason).includes('EXA_API_KEY')){q.length=0;}}
        else {searches+=Number(r?.searches??0); kept+=Number(r?.signals_created??r?.results_created??0);}
      }catch(err:any){errs++; console.log(`  !! ${e.name}: ${String(err?.message).slice(0,120)}`);}
      done_++; if(done_%20===0) console.log(`  ...${done_}/${shuffled.length}  searches=${searches} kept=${kept} errs=${errs}`);
    }
  }));
  console.log(`\nRAN ${done_} accounts | searches ${searches} | pages kept ${kept} | errors ${errs}`);
  console.log(`startedAt=${startedAt}`);
  console.log(`SAMPLE_IDS=${shuffled.map((e:any)=>e.id).join(',')}`);
}
main().catch(e=>{console.error(e);process.exit(1);});
