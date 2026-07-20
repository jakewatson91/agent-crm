import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'af602fa1-1e0b-4bee-9841-01894553e0a9';

async function pageAll<T>(b:(f:number,t:number)=>any):Promise<T[]>{const o:T[]=[];let f=0;for(;;){const{data,error}=await b(f,f+999);if(error)throw error;o.push(...(data as T[]));if(!data||data.length<1000)break;f+=1000;}return o;}

async function main(){
  // AgentMail facts
  const am = '3d63896f-6389-4acf-84b7-599ddfd51d74';
  const amf = await sb.from('facts').select('id, predicate, object_text, object_entity, supersedes, content_hash, created_at')
    .eq('workspace_id', WS).eq('subject_entity', am).order('predicate');
  console.log(`=== AgentMail: ${amf.data?.length} total fact rows ===`);
  const active = (amf.data??[]).filter((f:any)=>!f.supersedes);
  console.log(`active (non-superseded): ${active.length}`);
  for (const f of active) console.log(`  ${f.predicate.padEnd(22)} obj_text=${JSON.stringify(f.object_text)?.slice(0,55)}  obj_ent=${f.object_entity?String(f.object_entity).slice(0,8):'-'}`);

  // workspace-wide: group active facts by (subject, predicate) and count distinct object_text — >1 distinct = candidate semantic dupes within same relationship
  const all = await pageAll<any>((f,t)=>sb.from('facts').select('subject_entity, predicate, object_text, object_entity, supersedes').eq('workspace_id', WS).range(f,t));
  const act = all.filter(f=>!f.supersedes);
  console.log(`\n=== workspace: ${all.length} fact rows, ${act.length} active ===`);
  const grp = new Map<string, Set<string>>();
  for (const f of act){
    const k = `${f.subject_entity}::${f.predicate}`;
    const v = f.object_entity ? `ent:${f.object_entity}` : `txt:${(f.object_text??'').trim().toLowerCase()}`;
    (grp.get(k)??grp.set(k,new Set()).get(k))!.add(v);
  }
  let multi=0, freeText=0;
  for (const [,vals] of grp) if (vals.size>1){ multi++; if([...vals].some(v=>v.startsWith('txt:'))) freeText++; }
  console.log(`(subject,predicate) groups with >1 distinct value: ${multi}  (of which involve free-text values: ${freeText})`);
  console.log(`note: >1 distinct value is NOT necessarily a dup — could be legitimately many values (e.g. multiple investors). This bounds the surface, not the count.`);

  // predicate vocabulary spread: how controlled is it?
  const preds = new Map<string, number>();
  for (const f of act) preds.set(f.predicate, (preds.get(f.predicate)||0)+1);
  console.log(`\ndistinct predicates in use: ${preds.size}`);
  const sorted=[...preds.entries()].sort((a,b)=>b[1]-a[1]);
  console.log('top 25:', sorted.slice(0,25).map(([p,c])=>`${p}(${c})`).join(', '));
}
main().catch(e=>{console.error(e);process.exit(1);});
