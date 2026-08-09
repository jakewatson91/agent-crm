import { config } from 'dotenv'; config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
(async () => {
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS='e7052848-2270-41ac-90b6-d9b75c87f6d3';
const since=new Date(Date.now()-12*60*1000).toISOString();
const ev=(await sb.from('events').select('payload,created_at,target_id').eq('workspace_id',WS).eq('action','research_completed').gte('created_at',since).order('created_at',{ascending:false}).limit(30)).data as any[]??[];
console.log(`research runs completed in the last 12 min: ${ev.length}\n`);
let newCode=0;
for(const e of ev){
  const d=e.payload??{}; const ent=(await sb.from('entities').select('name').eq('id',e.target_id).maybeSingle()).data as any;
  const isNew = d.per_question !== undefined || d.per_angle_fetched !== undefined;
  if(isNew) newCode++;
  console.log(`${e.created_at.slice(11,19)}  ${String(ent?.name).slice(0,22).padEnd(24)} searches=${d.searches} kept=${d.results_created} ${isNew?'[NEW CODE]':'[old code]'}`);
  console.log(`    dropped=${JSON.stringify(d.filtered_by??{})}`);
  if(d.per_question) console.log(`    by_question=${JSON.stringify(d.per_question)}`);
  if(d.per_angle_fetched) console.log(`    fetched_per_search=${JSON.stringify(d.per_angle_fetched)}`);
  for(const s of (d.drop_sample??[]).slice(0,3)) console.log(`    dropped[${s.why}] via ${s.angle}: ${String(s.title).slice(0,58)}`);
}
console.log(`\nruns on the NEW code: ${newCode}/${ev.length}`);
})();
