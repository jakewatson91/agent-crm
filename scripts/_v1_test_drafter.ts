import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { runAgent } from '../inngest/functions/agent_logic.js';
import { loadBestContactScore } from '@agent-crm/tools';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const DRAFTER_SUB = 'dd548bc1-afaf-44e1-bf52-212d0a9914e5';
const DRAFTER_AGENT = 'claims_outbound_drafter';

async function main(){
  const ws = ((await sb.from('workspaces').select('id')).data??[]).find(w=>(w.id as string).startsWith('af602fa1'))!.id as string;
  const entId = '59bdb9bc';
  // resolve full id
  const ent = (await sb.from('entities').select('id,name').eq('workspace_id',ws).ilike('name','VibeFlow').maybeSingle()).data!;
  const best = await loadBestContactScore(sb, ws, ent.id as string);
  console.log(`account=${ent.name} best_contact_score=${best}`);

  // pick a current (non-superseded) substantive fact to use as the trigger
  const fr = (await sb.from('facts').select('id,predicate,object_text,supersedes').eq('workspace_id',ws).eq('subject_entity',ent.id)).data ?? [];
  const pointed = new Set(fr.map(r=>r.supersedes).filter(Boolean));
  const cur = fr.filter(f=>!pointed.has(f.id) && !f.predicate.startsWith('score_') && !['icp_fit','icp_fit_breakdown','contact_score'].includes(f.predicate));
  const trigger = cur.find(f=>['buying_signal','recent_event','pain_observed','hiring_role'].includes(f.predicate)) ?? cur[0];
  console.log(`trigger fact: ${trigger?.predicate} = ${String(trigger?.object_text).slice(0,80)} (id=${String(trigger?.id).slice(0,8)})`);
  if(!trigger){ console.log('no substantive fact to trigger with'); return; }

  const before = (await sb.from('gates').select('id',{count:'exact',head:true}).eq('workspace_id',ws)).count ?? 0;
  console.log(`gates before: ${before}`);

  const r = await runAgent(sb, { workspace_id: ws, agent: DRAFTER_AGENT, subscription_id: DRAFTER_SUB, fact_id: trigger.id as string } as any);
  console.log('runAgent result:', JSON.stringify(r));

  const after = (await sb.from('gates').select('id, policy, condition, channel_post_id, status',{count:'exact'}).eq('workspace_id',ws).order('requested_at',{ascending:false}).limit(3));
  console.log(`gates after: ${after.count}`);
  console.log('latest gates:', JSON.stringify(after.data,null,2));
  if((r as any).channel_post_id){
    const post = (await sb.from('channel_posts').select('kind, body').eq('id',(r as any).channel_post_id).maybeSingle()).data;
    console.log('DRAFT POST:\n', post?.body);
  }
}
main().catch(e=>{console.error('ERR',e);process.exit(1);});
