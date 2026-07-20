import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = '7c4f79b1-518f-4e64-b634-f61aa14b88d2';
(async () => {
  const count = await sb.from('events').select('id', { count: 'exact', head: true }).eq('workspace_id', WS);
  const oldest = await sb.from('events').select('created_at').eq('workspace_id', WS).order('created_at', { ascending: true }).limit(1).maybeSingle();
  const newest = await sb.from('events').select('created_at').eq('workspace_id', WS).order('created_at', { ascending: false }).limit(1).maybeSingle();
  console.log('event count:', count.count, 'oldest:', oldest.data?.created_at, 'newest:', newest.data?.created_at);
})();
