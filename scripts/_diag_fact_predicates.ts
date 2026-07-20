import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

(async () => {
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
const since = new Date(Date.now() - 7*24*3600*1000).toISOString();

async function fetchAll(build:(f:number,t:number)=>any){ let out:any[]=[]; let f=0; const pg=1000; while(true){ const {data,error}=await build(f,f+pg-1); if(error)throw error; if(!data||!data.length)break; out=out.concat(data); if(data.length<pg)break; f+=pg;} return out; }

// All facts created in last 7d (active, not superseded)
const facts = await fetchAll((f,t)=>sb.from('facts').select('id, predicate, object_text, object_entity, confidence, signal_id, created_at').eq('workspace_id',WS).gte('created_at',since).order('created_at',{ascending:false}).range(f,t));
console.log('facts created last 7d:', facts.length);

const dist=new Map<string,number>();
for(const f of facts){ dist.set(f.predicate,(dist.get(f.predicate)||0)+1); }
console.log('\n=== ALL facts by predicate (7d) ===');
for(const [p,c] of [...dist.entries()].sort((a,b)=>b[1]-a[1]).slice(0,25)) console.log(`  ${String(c).padStart(5)}  ${p}`);

// Which facts came from hiring_post signals?
const sigIds=[...new Set(facts.map(f=>f.signal_id).filter(Boolean))];
const sigType=new Map<string,string>();
for(let i=0;i<sigIds.length;i+=500){
  const chunk=sigIds.slice(i,i+500);
  const r=await sb.from('signals').select('id,type,structured_tags').in('id',chunk);
  for(const s of r.data||[]) sigType.set(s.id, (s.structured_tags?.signal_source)||s.type);
}
const hiringFacts=facts.filter(f=>f.signal_id && sigType.get(f.signal_id)==='ats');
console.log(`\nfacts traceable to an ATS hiring signal: ${hiringFacts.length} (of ${facts.filter(f=>f.signal_id).length} with a signal_id)`);
const hd=new Map<string,number>();
for(const f of hiringFacts){ hd.set(f.predicate,(hd.get(f.predicate)||0)+1); }
console.log('=== facts from ATS hiring signals by predicate ===');
for(const [p,c] of [...hd.entries()].sort((a,b)=>b[1]-a[1]).slice(0,25)) console.log(`  ${String(c).padStart(5)}  ${p}`);

// object_entity vs object_text (edges = investors/customers etc as entities)
const edge=facts.filter(f=>f.object_entity).length;
console.log(`\nfacts as ENTITY edges (object_entity set): ${edge} | as literal text: ${facts.length-edge}`);

// sample a few investor-ish predicates
const inv=facts.filter(f=>/invest|back|fund|vc|capital|raise/i.test(f.predicate));
console.log(`\ninvestor-ish predicate facts: ${inv.length}. sample:`);
for(const f of inv.slice(0,8)) console.log(`  ${f.predicate} = ${f.object_text ?? '[entity:'+String(f.object_entity).slice(0,8)+']'}  (src=${f.signal_id?sigType.get(f.signal_id):'none'})`);
})();
