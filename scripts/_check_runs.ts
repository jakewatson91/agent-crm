import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const wsId = 'af602fa1-1e0b-4bee-9841-01894553e0a9';

  // Correct signals query - source_id is in structured_tags
  const { data: signals } = await sb.from('signals').select('id, entity_id, structured_tags, created_at').eq('workspace_id', wsId).order('created_at', { ascending: false }).limit(10);
  console.log(`Signals (${signals?.length ?? 0}):`);
  for (const s of signals ?? []) {
    const tags = s.structured_tags as Record<string,unknown>;
    console.log(' ', s.created_at?.slice(0,16), 'src:', tags?.source_id?.toString().slice(0,20), 'entity:', s.entity_id?.slice(0,8) ?? 'null');
  }

  // Did subscriptions get deleted? Check for events around the delete
  const { data: allSubEvts } = await sb.from('events').select('action, created_at').eq('workspace_id', wsId).like('action', '%subscription%').order('created_at', { ascending: false }).limit(20);
  console.log('\nAll subscription events:');
  for (const e of allSubEvts ?? []) console.log(e.created_at?.slice(0,16), e.action);

  // Check migrations directory for recent drops
  console.log('\nSubscriptions now:', (await sb.from('subscriptions').select('id', { count: 'exact', head: true }).eq('workspace_id', wsId)).count);
}

main().catch(console.error);
