import { config } from 'dotenv'; config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
(async () => {
  const { data: gates, error } = await sb.from('gates').select('id, kind, status, created_at').eq('workspace_id', WS).order('created_at', { ascending: false }).limit(10);
  console.log('gates:', error ? error.message : JSON.stringify(gates, null, 2));
  const { data: events } = await sb.from('events').select('id, type, created_at').eq('workspace_id', WS).order('created_at', { ascending: false }).limit(15);
  console.log('\nrecent events:', JSON.stringify(events, null, 2));
})();
