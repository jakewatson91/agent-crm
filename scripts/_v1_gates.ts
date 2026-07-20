import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function main(){
  const ws=((await sb.from('workspaces').select('id')).data??[]).find(w=>(w.id as string).startsWith('af602fa1'))!.id as string;
  const all=(await sb.from('gates').select('policy, decision, requested_at, channel_post_id').eq('workspace_id',ws)).data ?? [];
  const pending=all.filter(g=>g.decision===null||g.decision===undefined);
  const decided=all.filter(g=>g.decision!==null&&g.decision!==undefined);
  console.log('total gates:', all.length, '| pending(decision null):', pending.length, '| decided:', decided.length);
  const byPolicy:Record<string,number>={}; let pendingNoPost=0;
  for(const g of pending){ byPolicy[g.policy??'null']=(byPolicy[g.policy??'null']??0)+1; if(!g.channel_post_id)pendingNoPost++; }
  console.log('pending by policy:', JSON.stringify(byPolicy));
  console.log('pending with NO channel_post (phantom):', pendingNoPost);
  const recent=pending.sort((a,b)=>String(b.requested_at).localeCompare(String(a.requested_at))).slice(0,8);
  console.log('recent pending:', recent.map(r=>String(r.requested_at).slice(0,10)+':'+(r.policy??'')).join(' | '));
  const decisions:Record<string,number>={}; for(const g of decided)decisions[String(g.decision)]=(decisions[String(g.decision)]??0)+1;
  console.log('decision values on decided:', JSON.stringify(decisions));
}
main().catch(e=>{console.error(e);process.exit(1);});
