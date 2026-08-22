import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { chatCompleteForWorkspace } from '@agent-crm/tools';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS='e7052848-2270-41ac-90b6-d9b75c87f6d3';
async function main(){
  const t=Date.now();
  try {
    const r:any = await chatCompleteForWorkspace(sb as any, WS, { model:'deepseek-v4-pro', behavior:'drafter', max_tokens: 200, messages:[{role:'user',content:'Reply with the single word: ok'}] } as any);
    console.log('OK in', ((Date.now()-t)/1000).toFixed(1)+'s', '|', String(r.text).slice(0,80), '| out tok', r.output_tokens);
  } catch(e:any){ console.log('FAILED in', ((Date.now()-t)/1000).toFixed(1)+'s', e.message?.slice(0,300)); }
}
main();
