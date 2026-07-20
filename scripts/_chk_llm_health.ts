import { config } from 'dotenv'; config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { chatCompleteForWorkspace } from '@agent-crm/tools';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const ws='af602fa1-1e0b-4bee-9841-01894553e0a9';
(async()=>{
  // healthy provider probe (model set correctly)
  try {
    const r = await chatCompleteForWorkspace(sb, ws, { model:'deepseek-v4-flash', behavior:'scoring', max_tokens:20, response_format:{type:'json_object'}, messages:[{role:'user',content:'Return JSON {"ok":1}'}] } as any);
    console.log(`probe small: OK text=${r.text?.slice(0,40)}`);
  } catch(e:any){ console.log(`probe small: ERR ${e?.message?.slice(0,300)}`); }

  // build Token Company's actual fact block and send it raw to capture the real error
  const { data } = await sb.from('facts').select('predicate, object_text, confidence').eq('subject_entity','ed3f4443-acc6-4394-a4e1-ab94f90b66bf').is('supersedes',null).order('observed_at',{ascending:false});
  const admin = new Set(['icp_fit','icp_fit_breakdown','domain','score_total','score_industry_match','score_stage_match','score_evidence_depth','score_signal_strength','score_recency','score_graph_proximity','contact_score']);
  const facts=(data??[]).slice(0,40).filter(f=>!admin.has(f.predicate));
  const block = facts.map(f=>`  ${f.predicate}=${f.object_text} (${f.confidence})`).join('\n');
  console.log(`\nTokenCo prompt: ${facts.length} facts, fact-block chars=${block.length}`);
  try {
    const r = await chatCompleteForWorkspace(sb, ws, { model:'deepseek-v4-flash', behavior:'scoring', max_tokens:350, response_format:{type:'json_object'}, messages:[{role:'system',content:'Score JSON only {"industry_match":0,"stage_match":0,"signal_strength":0,"reasoning":""}'},{role:'user',content:'FACTS:\n'+block}] } as any);
    console.log(`TokenCo call: OK text=${r.text?.slice(0,80)}`);
  } catch(e:any){ console.log(`TokenCo call: ERR ${e?.message?.slice(0,400)}`); }
})();
