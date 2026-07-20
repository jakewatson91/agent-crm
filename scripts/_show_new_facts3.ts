import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
async function main() {
  const { data } = await sb.from('events')
    .select('created_at, actor_id, action, payload, target_id')
    .eq('workspace_id', WS)
    .in('action', ['assert_fact', 'supersede_fact'])
    .eq('actor_id', 'default_enricher')
    .gte('created_at', '2026-07-14T02:15:00Z')
    .order('created_at', { ascending: true })
    .limit(3);
  for (const e of data ?? []) console.log(JSON.stringify(e.payload).slice(0, 400));
}
main().catch((e) => { console.error(e); process.exit(1); });
