import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
(async () => {
  const scoreCount = await sb.from('facts').select('id', { count: 'exact', head: true }).eq('workspace_id', WS).eq('predicate', 'score_total').is('supersedes', null);
  console.log('score_total facts (current):', scoreCount.count, 'at', new Date().toISOString());
})();
