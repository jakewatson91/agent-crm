import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = '7c4f79b1-518f-4e64-b634-f61aa14b88d2';
(async () => {
  const r = await sb.from('entities').select('id, name, attributes').eq('workspace_id', WS).eq('name', 'Dan Rayburn');
  console.log(JSON.stringify(r.data, null, 2));
})();
