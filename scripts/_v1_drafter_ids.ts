import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function main(){
  const ws = ((await sb.from('workspaces').select('id')).data??[]).find(w=>(w.id as string).startsWith('af602fa1'))!.id;
  const sub = (await sb.from('subscriptions').select('id, name, owner_id, agent_behavior, active, semantic_query').eq('workspace_id',ws).eq('agent_behavior','drafter').eq('active',true).maybeSingle()).data;
  console.log('active drafter sub:', JSON.stringify(sub,null,2));
  // does the top qualified account have any contacts / a channel already?
  for(const dom of ['vibeflow.ai','mastra.ai','agentmail.to']){
    const ent = (await sb.from('entities').select('id,name,attributes').eq('workspace_id',ws).contains('attributes',{domain:dom}).maybeSingle()).data;
    if(!ent){ console.log(dom,'-> no entity'); continue; }
    const contacts = (await sb.from('facts').select('subject_entity').eq('workspace_id',ws).eq('predicate','works_at').eq('object_entity',ent.id).is('supersedes',null)).data ?? [];
    const chan = (await sb.from('channels').select('id').eq('workspace_id',ws).eq('account_entity_id',ent.id).maybeSingle()).data;
    const aFact = (await sb.from('facts').select('id,predicate').eq('workspace_id',ws).eq('subject_entity',ent.id).eq('predicate','buying_signal').is('supersedes',null).limit(1).maybeSingle()).data;
    console.log(`${dom} -> ent=${String(ent.id).slice(0,8)} contacts=${contacts.length} channel=${chan?.id?'yes':'no'} buying_signal_fact=${aFact?.id?String(aFact.id).slice(0,8):'none'}`);
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
