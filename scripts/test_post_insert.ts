import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function main() {
  const channelId = 'c9e85c2b-3ca0-425e-979f-e26a17e8b6be';
  // Look at channel_posts schema by sampling
  const sample = await sb.from('channel_posts').select('*').limit(1);
  console.log('columns:', Object.keys(sample.data?.[0] ?? {}));
  // Try inserting a touch_draft to see error
  const insert = await sb.from('channel_posts').insert({
    channel_id: channelId,
    kind: 'touch_draft',
    body: 'test body',
  }).select('id').single();
  console.log('insert:', insert.data, 'error:', insert.error?.message, 'code:', insert.error?.code);
}
main();
