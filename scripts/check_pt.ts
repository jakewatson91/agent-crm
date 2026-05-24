import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function main() {
  const ws = await sb.from('workspaces').select('id').like('name', 'demo · agent-crm%').order('created_at', { ascending: false }).limit(1).single();
  const wsId = ws.data!.id;
  const ent = await sb.from('entities').select('id').eq('workspace_id', wsId).eq('kind', 'account').eq('name', '11x.ai').single();
  const accountId = ent.data!.id;
  console.log('account_id:', accountId);
  const ch = await sb.from('channels').select('id, kind, title, account_entity_id').eq('workspace_id', wsId).eq('account_entity_id', accountId);
  console.log('channels for account:', JSON.stringify(ch.data, null, 2));
  if (ch.data && ch.data.length) {
    const posts = await sb.from('channel_posts').select('id, kind, created_at, body').eq('channel_id', ch.data[0].id);
    console.log('posts in channel:', JSON.stringify(posts.data, null, 2));
  }
}
main();
