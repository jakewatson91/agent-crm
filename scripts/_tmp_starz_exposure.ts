/** Read-only: is the stale STARZPLAY pain actually reaching drafts? */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS='e7052848-2270-41ac-90b6-d9b75c87f6d3', ENT='291983ea-34ee-40a9-99b0-1ca928391ea2';
async function main(){
  const {data:e}=await sb.from('entities').select('id,name,attributes,archived_at').eq('id',ENT).single();
  console.log(`entity: ${(e as any).name}  archived=${(e as any).archived_at ?? 'no'}`);
  console.log(`attributes: ${JSON.stringify((e as any).attributes).slice(0,300)}\n`);
  const {data:f}=await sb.from('facts').select('predicate,object_text,observed_at').eq('workspace_id',WS).eq('subject_entity',ENT).in('predicate',['icp_fit','score_total']).order('observed_at',{ascending:false}).limit(4);
  console.log('score facts:'); for(const x of (f??[]) as any[]) console.log(`  ${x.predicate} = ${String(x.object_text).slice(0,120)}  (${x.observed_at.slice(0,10)})`);
  const {data:g}=await sb.from('gates').select('id,status,created_at,payload').eq('workspace_id',WS).order('created_at',{ascending:false}).limit(200);
  const mine=(g??[]).filter((x:any)=>JSON.stringify(x.payload??{}).includes('STARZPLAY'));
  console.log(`\ngates mentioning STARZPLAY: ${mine.length}`);
  for(const x of mine.slice(0,5)) console.log(`  ${x.created_at.slice(0,10)} ${x.status} ${JSON.stringify(x.payload).slice(0,400)}`);
  const {data:p}=await sb.from('channel_posts').select('id,created_at,body').eq('workspace_id',WS).ilike('body','%DRM%').order('created_at',{ascending:false}).limit(10);
  console.log(`\nchannel posts mentioning DRM: ${(p??[]).length}`);
  for(const x of (p??[]) as any[]) console.log(`  ${x.created_at.slice(0,16)} ${String(x.body).slice(0,220).replace(/\n/g,' ')}`);
}
main().catch(e=>{console.error(e);process.exit(1);});
