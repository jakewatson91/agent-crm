import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS='e7052848-2270-41ac-90b6-d9b75c87f6d3';
async function fetchAll(t:string,s:string,m:(q:any)=>any=q=>q){let o:any[]=[],f=0;for(;;){const{data,error}=await m(sb.from(t).select(s)).range(f,f+999);if(error){console.error(t,error.message);break;}o=o.concat(data??[]);if(!data||data.length<1000)break;f+=1000;}return o;}
async function main(){
  const chans = await fetchAll('channels','id,account_entity_id',(q:any)=>q.eq('workspace_id',WS));
  const cid = chans.map(c=>c.id);
  let drafts:any[]=[];
  for(let i=0;i<cid.length;i+=100){ const {data} = await sb.from('channel_posts').select('id,created_at,cites,channel_id').in('channel_id',cid.slice(i,i+100)).eq('kind','touch_draft'); drafts=drafts.concat(data??[]); }
  drafts.sort((a,b)=>b.created_at.localeCompare(a.created_at));
  const factIds = [...new Set(drafts.flatMap(d=>d.cites ?? []))];
  const facts:any[] = [];
  for(let i=0;i<factIds.length;i+=200){ const {data} = await sb.from('facts').select('id,happened_at,created_at,object_text,predicate').in('id',factIds.slice(i,i+200)); facts.push(...(data??[])); }
  const byId = new Map(facts.map(f=>[f.id,f]));
  const lags:number[]=[]; const ingestLags:number[]=[];
  for (const d of drafts) {
    for (const c of (d.cites ?? [])) {
      const f = byId.get(c); if (!f?.happened_at) continue;
      lags.push((Date.parse(d.created_at)-Date.parse(f.happened_at))/864e5);
      ingestLags.push((Date.parse(f.created_at)-Date.parse(f.happened_at))/864e5);
      break;
    }
  }
  const pct=(a:number[],p:number)=>{const s=[...a].sort((x,y)=>x-y);return s[Math.floor(s.length*p)]??NaN;};
  console.log('drafts with a dated cited fact:', lags.length, 'of', drafts.length);
  console.log('EVENT -> DRAFT lag (days):  p25', pct(lags,.25).toFixed(1), ' median', pct(lags,.5).toFixed(1), ' p75', pct(lags,.75).toFixed(1), ' max', Math.max(...lags).toFixed(1));
  console.log('  share drafted within 2 days of the event:', (lags.filter(l=>l<=2).length/lags.length*100).toFixed(0)+'%');
  console.log('  share drafted within 7 days:', (lags.filter(l=>l<=7).length/lags.length*100).toFixed(0)+'%');
  console.log('EVENT -> WE LEARNED IT lag (days): median', pct(ingestLags,.5).toFixed(1), ' p75', pct(ingestLags,.75).toFixed(1));
  console.log('  share we learned within 2 days:', (ingestLags.filter(l=>l<=2).length/ingestLags.length*100).toFixed(0)+'%');
}
main();
