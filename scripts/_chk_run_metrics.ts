import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function main() {
  const since = new Date(Date.now() - 48 * 3600e3).toISOString();
  const { data } = await sb.from('events')
    .select('workspace_id, actor_id, action, created_at, payload')
    .in('action', ['agent_run_metrics', 'agent_dispatch_result'])
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(40);
  for (const e of data ?? []) {
    console.log(`${e.created_at}  ${e.workspace_id.slice(0,8)}  ${e.action}  actor=${e.actor_id}`);
    console.log(`   ${JSON.stringify(e.payload)?.slice(0, 300)}`);
  }
  if (!data?.length) console.log('no agent_run_metrics / agent_dispatch_result events in 48h');
}
main().catch((e) => { console.error(e); process.exit(1); });
