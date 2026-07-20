import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function main(){
  const ws=((await sb.from('workspaces').select('id')).data??[]).find((w:any)=>(w.id as string).startsWith('af602fa1'))!.id as string;
  const since='2026-07-01T15:12:30.000Z';
  const ev=(await sb.from('events').select('action, created_at').eq('workspace_id',ws).gte('created_at',since).order('created_at',{ascending:true})).data ?? [];
  const byAction:Record<string,number>={}; for(const e of ev)byAction[e.action]=(byAction[e.action]??0)+1;
  console.log('events since bg start:', ev.length, JSON.stringify(byAction));
  if(ev.length) console.log('  first:', ev[0].created_at, '| last:', ev[ev.length-1].created_at);
}
main().catch(e=>{console.error(e);process.exit(1);});
