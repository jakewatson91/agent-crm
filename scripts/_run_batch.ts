// Runs the advance pass against WHATEVER the workspace has configured (no config
// writes). Brackets the run with the Hunter balance so spend is exact.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { advanceAccounts } from '../inngest/functions/advance_accounts.js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function hunter(){ const j:any = await (await fetch(`https://api.hunter.io/v2/account?api_key=${process.env.HUNTER_API_KEY}`)).json(); const s=j?.data?.requests?.searches??{}; return {used:s.used,available:s.available}; }
async function main(){
  const ws=((await sb.from('workspaces').select('id')).data??[]).find((w:any)=>(w.id as string).startsWith('af602fa1'))!.id as string;
  const before=await hunter(); console.log('HUNTER BEFORE:',JSON.stringify(before));
  console.log(new Date().toISOString(),'BATCH START (contactCap=25)');
  const r=await advanceAccounts(sb,{workspace_id:ws,contactCap:25,draftCap:25,maxAccounts:300,onEvent:(l)=>console.log(l)});
  console.log(new Date().toISOString(),'RESULT',JSON.stringify(r));
  const after=await hunter(); console.log('HUNTER AFTER:',JSON.stringify(after));
  if(typeof before.used==='number'&&typeof after.used==='number') console.log(`CREDITS SPENT: ${after.used-before.used}  |  REMAINING: ${50-(after.used??0)}`);
}
main().catch(e=>{console.error('ERR',e);process.exit(1);});
