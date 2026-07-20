import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const ws = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
  const ent = await sb.from('entities').select('id,name,attributes').eq('workspace_id', ws).ilike('name', '%approxima%');
  console.log(JSON.stringify(ent.data, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
