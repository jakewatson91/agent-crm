import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function main() {
  const del = await sb.from('channel_posts').delete().eq('id', '9477af62-01f6-4554-875b-8465179223dd');
  console.log('cleanup test post:', del.error?.message ?? 'ok');
}
main();
