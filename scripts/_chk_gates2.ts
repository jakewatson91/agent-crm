import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
async function main() {
  const { data, error } = await sb.from('gates').select('*').eq('workspace_id', WS);
  if (error) { console.log('ERROR:', error.message); return; }
  for (const g of data ?? []) {
    const { channel_post_id, ...rest } = g as Record<string, unknown>;
    console.log(JSON.stringify(rest).slice(0, 260));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
