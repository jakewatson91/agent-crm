import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function main(){
  const ws=((await sb.from('workspaces').select('id')).data??[]).find(w=>(w.id as string).startsWith('af602fa1'))!.id as string;
  const since=new Date(Date.now()-15*60_000).toISOString();
  // pending gates (approvals) now
  const gates=(await sb.from('gates').select('channel_post_id, condition, requested_at').eq('workspace_id',ws).is('decision',null).order('requested_at',{ascending:false})).data ?? [];
  console.log('PENDING gates (approvals) now:', gates.length);
  for(const g of gates){ const c=g.condition as any; console.log(`  ${String(g.requested_at).slice(11,19)}  ${c?.entity_name??'?'}  to=${c?.to_email??'(none)'}  subj="${(c?.subject??'').slice(0,55)}"`); }
  // contacts_completed markers in last 15 min (pull attempts)
  const pulls=(await sb.from('events').select('target_id, summary:payload, created_at').eq('workspace_id',ws).eq('action','contacts_completed').gte('created_at',since).order('created_at',{ascending:false})).data ?? [];
  console.log('\ncontact PULL attempts in last 15min:', pulls.length);
  for(const p of pulls.slice(0,20)){ const pl=p.summary as any; console.log(`  ${String(p.created_at).slice(11,19)}  ${String(pl?.summary??'').slice(0,70)}`); }
  // new contact entities in last 15 min
  const nc=(await sb.from('entities').select('id,name,is_a,created_at').eq('workspace_id',ws).eq('is_a','contact').gte('created_at',since)).data ?? [];
  console.log('\nnew CONTACT entities in last 15min:', nc.length, nc.map(c=>c.name).slice(0,15).join(', '));
}
main().catch(e=>{console.error(e);process.exit(1);});
