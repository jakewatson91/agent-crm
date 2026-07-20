import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { advanceAccounts } from '../inngest/functions/advance_accounts.js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function main(){
  const ws=((await sb.from('workspaces').select('id')).data??[]).find((w:any)=>(w.id as string).startsWith('af602fa1'))!.id as string;
  console.log(new Date().toISOString(),'PHASE-1 START (draft-ready only, no pulls)');
  const r = await advanceAccounts(sb, { workspace_id: ws, contactCap: 0, draftCap: 15, maxAccounts: 200, onEvent: (l)=>console.log(l) });
  console.log(new Date().toISOString(),'DONE',JSON.stringify(r));
}
main().catch(e=>{console.error('ERR',e);process.exit(1);});
