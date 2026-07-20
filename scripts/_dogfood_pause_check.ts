import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
(async () => {
  const { data } = await sb.from('workspaces').select('policy').eq('id', WS).maybeSingle();
  const policy: any = data?.policy ?? {};
  console.log('pipeline:', JSON.stringify(policy.pipeline, null, 2));
  console.log('research.searches_per_run:', policy.research?.searches_per_run);
})();
