import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function main() {
  // What author_kind values exist?
  const sample = await sb.from('channel_posts').select('author_kind, author_id, kind').limit(100);
  const kinds = new Set((sample.data ?? []).map(p => p.author_kind));
  const postKinds = new Set((sample.data ?? []).map(p => p.kind));
  console.log('author_kind distinct:', [...kinds]);
  console.log('post kind distinct:', [...postKinds]);
  // Find an example author for each
  const examples = sample.data?.slice(0, 5);
  console.log('first 5 posts (author_kind, author_id, kind):', JSON.stringify(examples, null, 2));
  
  // Try a touch_draft insert with author_kind='agent'
  const channelId = 'c9e85c2b-3ca0-425e-979f-e26a17e8b6be';
  const insert = await sb.from('channel_posts').insert({
    channel_id: channelId,
    author_kind: 'agent',
    author_id: '00000000-0000-0000-0000-000000000000',
    kind: 'touch_draft',
    body: 'test touch_draft body',
  }).select('id').single();
  console.log('insert result:', insert.data, 'error:', insert.error?.message);
}
main();
