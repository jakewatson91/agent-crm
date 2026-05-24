import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function main() {
  const wsId = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
  const acc = '674f11ab-aa85-40d6-a37b-4c4527f4d5d8';
  const byAcc = await sb.from('channels').select('id, title, account_entity_id').eq('workspace_id', wsId).eq('account_entity_id', acc);
  console.log('11x.ai channels:', JSON.stringify(byAcc.data, null, 2), 'error:', byAcc.error?.message);
  // Try inserting a clean channel (no kind)
  const ins = await sb.from('channels').insert({ workspace_id: wsId, account_entity_id: acc, title: 'Account: 11x.ai' }).select('id').single();
  console.log('insert result:', ins.data, 'error:', ins.error?.message);
  // Then list channel_posts kinds available
  const posts = await sb.from('channel_posts').select('kind').limit(10);
  console.log('post kinds seen:', [...new Set((posts.data ?? []).map(p => p.kind))]);
}
main();
