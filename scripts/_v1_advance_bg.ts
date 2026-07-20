import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { advanceAccounts } from '../inngest/functions/advance_accounts.js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function main(){
  const ws=((await sb.from('workspaces').select('id')).data??[]).find(w=>(w.id as string).startsWith('af602fa1'))!.id as string;
  console.log(new Date().toISOString(),'START advance');
  const r = await advanceAccounts(sb, { workspace_id: ws, contactCap: 20, draftCap: 10, maxAccounts: 70 });
  console.log(new Date().toISOString(),'DONE',JSON.stringify(r));
}
main().catch(e=>{console.error('ERR',e);process.exit(1);});
