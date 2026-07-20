import { config } from 'dotenv'; config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { scoreEntity } from '@agent-crm/tools';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const ws='af602fa1-1e0b-4bee-9841-01894553e0a9';
(async()=>{
  const s = await scoreEntity(sb, ws, 'ed3f4443-acc6-4394-a4e1-ab94f90b66bf');
  console.log('result:', s===null?'NULL':`icp=${s.icp_total.toFixed(2)}`);
})();
