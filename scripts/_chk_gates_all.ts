import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
async function main() {
  const { count: total } = await sb.from('gates').select('id', { count: 'exact', head: true }).eq('workspace_id', WS);
  console.log('total gates ever (Sudden):', total);
  const { data } = await sb.from('gates').select('id, created_at, decided_at, decision').eq('workspace_id', WS).order('created_at', { ascending: false }).limit(10);
  for (const g of data ?? []) console.log(`  ${g.created_at.slice(0, 16)}  decided=${g.decided_at?.slice(0, 16) ?? 'PENDING'}  decision=${g.decision ?? '-'}`);
  const { data: drafts } = await sb.from('channel_posts').select('id, created_at, kind, channel_id').eq('kind', 'touch_draft').order('created_at', { ascending: false }).limit(10);
  let n = 0;
  for (const d of drafts ?? []) {
    const { data: ch } = await sb.from('channels').select('workspace_id, account_entity_id').eq('id', d.channel_id).single();
    if (ch?.workspace_id !== WS) continue;
    const { data: ent } = await sb.from('entities').select('name').eq('id', ch.account_entity_id).single();
    console.log(`  draft post ${d.created_at.slice(0, 16)}  ${ent?.name}`);
    n++;
  }
  if (!n) console.log('  no touch_draft posts found for Sudden in latest 10 global');
}
main().catch((e) => { console.error(e); process.exit(1); });
