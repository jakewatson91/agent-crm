import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
async function main() {
  const { data } = await sb.from('events')
    .select('created_at, actor_id, action, payload')
    .eq('workspace_id', WS)
    .gte('created_at', '2026-07-14T01:49:00Z')
    .not('action', 'in', '(subscription.matched,create_signal,research_completed,research_error,research_triggered)')
    .order('created_at', { ascending: true })
    .limit(40);
  for (const e of data ?? []) {
    console.log(`${e.created_at.slice(11, 19)}  ${e.action}  actor=${e.actor_id}  ${JSON.stringify(e.payload)?.slice(0, 160)}`);
  }
  console.log('total:', data?.length ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
