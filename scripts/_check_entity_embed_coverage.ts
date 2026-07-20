import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const ws = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
  const entities = await sb.from('entities').select('id', { count: 'exact', head: true }).eq('workspace_id', ws);
  console.log('total entities:', entities.count);

  const ids = await sb.from('entities').select('id').eq('workspace_id', ws).limit(5000);
  const idList = (ids.data ?? []).map((e: any) => e.id);
  const embeds = await sb.from('entity_embeddings').select('entity_id', { count: 'exact', head: true }).in('entity_id', idList.slice(0, 1000));
  console.log('entities with any embedding (first 1000 checked):', embeds.count, embeds.error?.message);

  const total = await sb.from('entity_embeddings').select('entity_id', { count: 'exact', head: true });
  console.log('total entity_embeddings rows in DB:', total.count, total.error?.message);
}
main().catch((e) => { console.error(e); process.exit(1); });
