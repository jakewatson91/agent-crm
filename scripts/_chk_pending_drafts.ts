import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
async function main() {
  const { data: gates } = await sb.from('gates')
    .select('id, created_at, channel_post_id, decided_at')
    .eq('workspace_id', WS).is('decided_at', null)
    .order('created_at', { ascending: false });
  console.log(`pending approvals: ${gates?.length ?? 0}`);
  for (const g of gates ?? []) {
    const { data: post } = await sb.from('channel_posts').select('kind, body, channel_id').eq('id', g.channel_post_id).single();
    const { data: ch } = await sb.from('channels').select('account_entity_id').eq('id', post!.channel_id).single();
    const { data: ent } = await sb.from('entities').select('name').eq('id', ch!.account_entity_id).single();
    console.log(`  ${g.created_at.slice(0, 16)}  ${ent?.name}  [${post?.kind}]  ${post?.body?.slice(0, 90).replace(/\n/g, ' ')}`);
  }
  const { data: pol } = await sb.from('workspaces').select('policy').eq('id', WS).single();
  console.log('pipeline:', JSON.stringify((pol!.policy as Record<string, unknown>).pipeline));
}
main().catch((e) => { console.error(e); process.exit(1); });
