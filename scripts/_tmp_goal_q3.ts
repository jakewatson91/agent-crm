import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function main() {
  const { data: ch } = await sb.from('channels').select('*').limit(2);
  console.log('channels keys:', Object.keys(ch?.[0] ?? {}));
  console.log(JSON.stringify(ch?.[0], null, 2).slice(0,800));
  const { count } = await sb.from('channel_posts').select('id', {count:'exact', head:true}).eq('kind','touch_draft');
  console.log('total touch_draft posts (all ws):', count);
  const { data: d } = await sb.from('channel_posts').select('id,channel_id,created_at,withdrawn_at,argument_id').eq('kind','touch_draft').order('created_at',{ascending:false}).limit(5);
  console.log(d);
}
main();
