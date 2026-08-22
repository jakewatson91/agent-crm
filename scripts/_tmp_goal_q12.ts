import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS='e7052848-2270-41ac-90b6-d9b75c87f6d3';
async function fetchAll(t:string,s:string,m:(q:any)=>any=q=>q){let o:any[]=[],f=0;for(;;){const{data,error}=await m(sb.from(t).select(s)).range(f,f+999);if(error){console.error(t,error.message);break;}o=o.concat(data??[]);if(!data||data.length<1000)break;f+=1000;}return o;}
async function main(){
  const ents = await fetchAll('entities','id,name,attributes,archived_at',(q:any)=>q.eq('workspace_id',WS));
  const live = ents.filter(e=>!e.archived_at);
  const kind = (e:any)=> e.attributes?.is_a ?? e.attributes?.type ?? 'unknown';
  const k: Record<string,number> = {}; for (const e of live) k[kind(e)]=(k[kind(e)]??0)+1;
  console.log('live entities by kind', k, '| total incl archived', ents.length);
  const accounts = live.filter(e=>kind(e)==='account');
  const facts = await fetchAll('facts','id,subject_entity,happened_at,predicate,created_at',(q:any)=>q.eq('workspace_id',WS));
  const now = Date.now();
  const dated = facts.filter(f=>f.happened_at);
  const fresh = dated.filter(f=>(now-Date.parse(f.happened_at))<30*864e5);
  const accIds = new Set(accounts.map(a=>a.id));
  const freshAcc = new Set(fresh.map(f=>f.subject_entity).filter(id=>accIds.has(id)));
  const anyFactAcc = new Set(facts.map(f=>f.subject_entity).filter(id=>accIds.has(id)));
  console.log('\nFUNNEL (Sudden)');
  console.log('  live accounts           ', accounts.length);
  console.log('  with any fact           ', anyFactAcc.size, `(${(anyFactAcc.size/accounts.length*100).toFixed(0)}%)`);
  console.log('  total facts             ', facts.length, '| dated', dated.length, '| dated inside 30d', fresh.length);
  console.log('  accounts w/ fresh dated ', freshAcc.size, `(${(freshAcc.size/accounts.length*100).toFixed(1)}% of book) <- the draftable pool`);
  const pred: Record<string,number> = {}; for (const f of fresh) pred[f.predicate]=(pred[f.predicate]??0)+1;
  console.log('\n  fresh predicates:', Object.entries(pred).sort((a,b)=>b[1]-a[1]).slice(0,12));
  // drafts in the last 30d for this workspace
  const chans = await fetchAll('channels','id,account_entity_id',(q:any)=>q.eq('workspace_id',WS));
  console.log('\n  channels', chans.length);
  const cid = chans.map(c=>c.id);
  let drafts: any[] = [];
  for (let i=0;i<cid.length;i+=100){ const { data } = await sb.from('channel_posts').select('id,created_at,withdrawn_at').in('channel_id',cid.slice(i,i+100)).eq('kind','touch_draft'); drafts=drafts.concat(data??[]); }
  const d30 = drafts.filter(d=>(now-Date.parse(d.created_at))<30*864e5);
  console.log('  drafts ever', drafts.length, '| last 30d', d30.length, '| of those withdrawn', d30.filter(d=>d.withdrawn_at).length);
}
main();
