import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
async function main() {
  const { data: gates } = await sb.from('gates')
    .select('id, created_at, decided_at, decision, channel_post_id')
    .eq('workspace_id', WS).not('decided_at', 'is', null)
    .order('decided_at', { ascending: false }).limit(5);
  for (const g of gates ?? []) {
    const { data: post } = await sb.from('channel_posts').select('kind, channel_id').eq('id', g.channel_post_id).single();
    const { data: ch } = await sb.from('channels').select('account_entity_id').eq('id', post!.channel_id).single();
    const { data: ent } = await sb.from('entities').select('name').eq('id', ch!.account_entity_id).single();
    console.log(`${g.decided_at!.slice(0, 16)}  ${g.decision}  ${ent?.name}  [${post?.kind}]`);
  }
  // recent touches (sends)
  const { data: touches } = await sb.from('touches')
    .select('created_at, status, to_email:contact_entity_id, sent_at')
    .eq('workspace_id', WS).order('created_at', { ascending: false }).limit(5);
  console.log('recent touches:', JSON.stringify(touches));
}
main().catch((e) => { console.error(e); process.exit(1); });
