import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = '7c4f79b1-518f-4e64-b634-f61aa14b88d2';
(async () => {
  const acct = await sb.from('facts').select('id', { count: 'exact', head: true }).eq('workspace_id', WS).eq('predicate','is_a').eq('object_text','account');
  const contact = await sb.from('facts').select('id', { count: 'exact', head: true }).eq('workspace_id', WS).eq('predicate','is_a').eq('object_text','contact');
  const sig = await sb.from('signals').select('id', { count: 'exact', head: true }).eq('workspace_id', WS);
  console.log('accounts so far:', acct.count, 'contacts so far:', contact.count, 'signals so far:', sig.count);
})();
