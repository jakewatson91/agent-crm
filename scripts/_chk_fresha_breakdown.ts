import { config } from 'dotenv'; config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const ws='af602fa1-1e0b-4bee-9841-01894553e0a9';
const fresha='1e044f27-69fb-4905-ba10-ec9122002663';
// current = max observed_at per predicate (not the supersedes-null original)
async function cur(pred:string){
  const { data } = await sb.from('facts').select('object_text, observed_at').eq('subject_entity',fresha).eq('predicate',pred).order('observed_at',{ascending:false}).limit(1);
  return data?.[0]?.object_text ?? '(none)';
}
(async()=>{
  for (const p of ['icp_fit','score_industry_match','score_stage_match','score_signal_strength','score_evidence_depth','score_recency','score_graph_proximity']) {
    console.log(`  ${p.padEnd(26)} = ${await cur(p)}`);
  }
  const { data: br } = await sb.from('facts').select('object_text, observed_at').eq('subject_entity',fresha).eq('predicate','icp_fit_breakdown').order('observed_at',{ascending:false}).limit(1);
  console.log('\nreasoning:', (br?.[0]?.object_text ?? '(none)'));
  // what does the system actually KNOW about Fresha's size/stage? dump ground-truth-ish attrs + facts
  const { data: ent } = await sb.from('entities').select('name, attributes').eq('id',fresha).maybeSingle();
  console.log('\nattributes:', JSON.stringify(ent?.attributes));
  const { data: gt } = await sb.from('facts').select('predicate, object_text').eq('subject_entity',fresha).is('supersedes',null).in('predicate',['employee_count','company_size','stage','funding_stage','headcount','founded','about','description']);
  console.log('size/stage facts:', JSON.stringify((gt??[]).map(f=>`${f.predicate}=${f.object_text}`)));
  // ICP the scorer compares against
  const { data: w } = await sb.from('workspaces').select('icp').eq('id',ws).maybeSingle();
  console.log('\nworkspace ICP:', JSON.stringify(w?.icp));
})();
