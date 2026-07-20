import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function main(){
  const ws=((await sb.from('workspaces').select('id')).data??[]).find((w:any)=>(w.id as string).startsWith('af602fa1'))!.id as string;
  const g=(await sb.from('gates').select('condition, requested_at, channel_post_id').eq('workspace_id',ws).is('decision',null).order('requested_at',{ascending:false})).data ?? [];
  console.log('PENDING approvals:', g.length);
  for(const x of g){const c=x.condition as any; console.log(`  ${String(x.requested_at).slice(11,19)}  ${(c?.entity_name??'?').padEnd(18)} -> ${c?.to_email??'(none)'}  "${(c?.subject??'').slice(0,40)}"`);}
}
main().catch(e=>{console.error(e);process.exit(1);});
