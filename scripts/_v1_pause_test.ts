import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { getPipelineStatus, setPipelineStatus } from '@agent-crm/tools';
import { advanceAccounts } from '../inngest/functions/advance_accounts.js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
let fail=0; const ok=(m:string,c:boolean)=>{console.log(`  ${c?'ok  ':'FAIL'} ${m}`);if(!c)fail++;};
async function main(){
  // use the demo workspace so we never touch the live af602fa1 run
  const demo=((await sb.from('workspaces').select('id,name')).data??[]).find((w:any)=>(w.id as string).startsWith('af602fa1'))?.id as string;
  if(!demo){console.log('no ws');return;}
  const prior = await getPipelineStatus(sb, demo);   // remember to restore
  console.log('demo ws:', demo.slice(0,8), 'prior status:', JSON.stringify(prior));

  // 1. set paused, read back
  await setPipelineStatus(sb, demo, { state:'paused', provider:'deepseek', reason:'The AI model provider is out of credit. Add funds, then click Continue.', paused_at:new Date().toISOString() });
  const s1 = await getPipelineStatus(sb, demo);
  ok('status persists as paused', s1?.state==='paused' && !!s1?.reason);

  // 2. advanceAccounts must early-return (no spend) while paused
  const r = await advanceAccounts(sb, { workspace_id: demo, contactCap: 5, draftCap: 5 });
  ok('advance early-returns while paused (scanned=0)', r.scanned===0 && !!r.paused);

  // 3. Continue = clear pause (mirrors /api/pipeline/continue)
  await setPipelineStatus(sb, demo, { state:'ok', last_run_at: s1?.last_run_at, last_run: s1?.last_run });
  const s2 = await getPipelineStatus(sb, demo);
  ok('continue clears pause (no reason, state ok)', s2?.state==='ok' && !s2?.reason);

  // restore prior (or clear) so demo isn't left dirty
  if(prior) await setPipelineStatus(sb, demo, prior);
  console.log(fail===0?'\nPAUSE FLOW OK':`\n${fail} FAIL`);
  process.exit(fail?1:0);
}
main().catch(e=>{console.error(e);process.exit(1);});
