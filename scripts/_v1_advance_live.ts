import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { advanceAccounts } from '../inngest/functions/advance_accounts.js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function main(){
  const ws=((await sb.from('workspaces').select('id')).data??[]).find(w=>(w.id as string).startsWith('af602fa1'))!.id as string;
  const before=(await sb.from('gates').select('id',{count:'exact',head:true}).eq('workspace_id',ws).is('decision',null)).count ?? 0;
  console.log('pending gates before:', before);
  const t0=Date.now();
  const r = await advanceAccounts(sb, { workspace_id: ws, contactCap: 12, draftCap: 12, maxAccounts: 60 });
  console.log(`\nadvanceAccounts done in ${((Date.now()-t0)/1000).toFixed(0)}s`);
  console.log(JSON.stringify(r,null,2));
  const after=(await sb.from('gates').select('id, channel_post_id, condition, requested_at',{count:'exact'}).eq('workspace_id',ws).is('decision',null).order('requested_at',{ascending:false}));
  console.log('\npending gates after:', after.count);
  for(const g of (after.data??[]).slice(0,12)){
    const c=g.condition as any;
    console.log(`  -> ${c?.entity_name ?? '?'}  to=${c?.to_email ?? '(none)'}  subj="${(c?.subject??'').slice(0,60)}"`);
  }
}
main().catch(e=>{console.error('ERR',e);process.exit(1);});
