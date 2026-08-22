import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS='e7052848-2270-41ac-90b6-d9b75c87f6d3';
async function fetchAll(t:string,s:string,m:(q:any)=>any=q=>q){let o:any[]=[],f=0;for(;;){const{data,error}=await m(sb.from(t).select(s)).range(f,f+999);if(error){console.error(t,error.message);break;}o=o.concat(data??[]);if(!data||data.length<1000)break;f+=1000;}return o;}
async function main(){
  const chans = await fetchAll('channels','id',(q:any)=>q.eq('workspace_id',WS));
  const cid = chans.map(c=>c.id);
  let drafts:any[]=[];
  for(let i=0;i<cid.length;i+=100){ const {data} = await sb.from('channel_posts').select('id,created_at,cites').in('channel_id',cid.slice(i,i+100)).eq('kind','touch_draft'); drafts=drafts.concat(data??[]); }
  const factIds=[...new Set(drafts.flatMap(d=>d.cites??[]))];
  const facts:any[]=[];
  for(let i=0;i<factIds.length;i+=200){ const {data}=await sb.from('facts').select('id,created_at,happened_at').in('id',factIds.slice(i,i+200)); facts.push(...(data??[])); }
  const byId=new Map(facts.map(f=>[f.id,f]));
  const pipe:number[]=[];
  for(const d of drafts){ for(const c of (d.cites??[])){ const f=byId.get(c); if(!f) continue; pipe.push((Date.parse(d.created_at)-Date.parse(f.created_at))/864e5); break; } }
  const pct=(a:number[],p:number)=>{const s=[...a].sort((x,y)=>x-y);return s[Math.floor(s.length*p)]??NaN;};
  console.log('FACT LANDS -> DRAFT WRITTEN (days): n=',pipe.length,' p25',pct(pipe,.25).toFixed(1),' median',pct(pipe,.5).toFixed(1),' p75',pct(pipe,.75).toFixed(1));
  console.log('  same day:', (pipe.filter(x=>x<1).length/pipe.length*100).toFixed(0)+'%');
  // approval lag
  const gates = await fetchAll('gates','requested_at,decided_at,decision',(q:any)=>q.eq('workspace_id',WS).eq('policy','outreach_send'));
  const app = gates.filter(g=>g.decided_at).map(g=>(Date.parse(g.decided_at)-Date.parse(g.requested_at))/864e5);
  console.log('DRAFT -> HUMAN DECIDES (days): n=',app.length,' median',pct(app,.5).toFixed(1),' p75',pct(app,.75).toFixed(1));
  const pend = gates.filter(g=>!g.decided_at);
  console.log('undecided gates:', pend.length, '| oldest waiting (days):', pend.length?((Date.now()-Math.min(...pend.map(g=>Date.parse(g.requested_at))))/864e5).toFixed(0):'-');
}
main();
