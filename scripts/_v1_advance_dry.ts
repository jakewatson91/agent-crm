import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { advanceAccounts, isHaltingError } from '../inngest/functions/advance_accounts.js';
import { getPipelineStatus } from '@agent-crm/tools';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function main(){
  const ws=((await sb.from('workspaces').select('id')).data??[]).find(w=>(w.id as string).startsWith('af602fa1'))!.id as string;
  // halting-error classifier sanity
  const cases: [string, boolean][] = [
    ['Hunter 402: Insufficient Balance', true],
    ['DeepSeek 429 rate limit exceeded', true],
    ['401 Unauthorized', true],
    ['Explorium match 200: no business found', false],
    ['no domain', false],
    ['some transient network ECONNRESET', false],
  ];
  console.log('isHaltingError:');
  for(const [m,exp] of cases){ const got=isHaltingError(m); console.log(`  ${got===exp?'OK ':'XX '} ${got}\t"${m}"`); }
  // DRY: scan 8 accounts, pull nothing, draft nothing — just plumbing + tallies.
  console.log('\ndry advanceAccounts(contactCap:0, draftCap:0, maxAccounts:8):');
  const r = await advanceAccounts(sb, { workspace_id: ws, contactCap: 0, draftCap: 0, maxAccounts: 8 });
  console.log(JSON.stringify(r, null, 2));
  console.log('pipeline status now:', JSON.stringify(await getPipelineStatus(sb, ws)));
}
main().catch(e=>{console.error('ERR',e);process.exit(1);});
