import { config } from 'dotenv'; config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { chatCompleteForWorkspace } from '@agent-crm/tools';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const ws='e7052848-2270-41ac-90b6-d9b75c87f6d3';
(async()=>{
  try {
    const r = await chatCompleteForWorkspace(sb, ws, { model:'deepseek-v4-flash', behavior:'scoring', max_tokens:20, response_format:{type:'json_object'}, messages:[{role:'user',content:'Return JSON {"ok":1}'}] } as any);
    console.log(`probe: OK text=${r.text?.slice(0,60)}`);
  } catch(e:any){ console.log(`probe: ERR ${e?.message?.slice(0,300)}`); }
})();
