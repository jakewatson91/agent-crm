import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function main(){
  const ws=((await sb.from('workspaces').select('id')).data??[]).find((w:any)=>(w.id as string).startsWith('af602fa1'))!.id as string;
  const since=new Date(Date.now()-12*60_000).toISOString();
  // contact pulls
  const pulls=(await sb.from('events').select('payload, created_at').eq('workspace_id',ws).eq('action','contacts_completed').gte('created_at',since).order('created_at',{ascending:true})).data ?? [];
  console.log(`CONTACT PULLS (last 12m): ${pulls.length}`);
  let found=0; for(const p of pulls){const s=String((p.payload as any)?.summary??''); if(/\d+ new contact/.test(s)&&!/^0 /.test(s))found++; console.log(`  ${String(p.created_at).slice(11,19)} ${s.slice(0,60)}`);}
  // drafter runs (metrics events)
  const dr=(await sb.from('events').select('payload, created_at').eq('workspace_id',ws).eq('action','agent_run_metrics').gte('created_at',since)).data ?? [];
  const drafterRuns=dr.filter(d=>(d.payload as any)?.behavior==='drafter');
  console.log(`\nDRAFTER LLM RUNS (last 12m): ${drafterRuns.length}`);
  // drafter decision outcomes: touch_draft posts vs decision (skip) posts in last 12m
  const posts=(await sb.from('channel_posts').select('kind, body, created_at').gte('created_at',since).order('created_at',{ascending:true})).data ?? [];
  const drafts=posts.filter(p=>p.kind==='touch_draft');
  const decisions=posts.filter(p=>p.kind==='decision'&&/facts_insufficient|watch|drop|enrich/.test(String(p.body)));
  console.log(`  -> touch_draft posts: ${drafts.length}`);
  console.log(`  -> skip/insufficient decisions: ${decisions.length}`);
  for(const d of decisions.slice(0,8)) console.log(`     · ${String(d.body).slice(0,90)}`);
}
main().catch(e=>{console.error(e);process.exit(1);});
