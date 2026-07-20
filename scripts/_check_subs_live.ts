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
  const subs = await sb.from('subscriptions')
    .select('id,name,owner_id,active,structured_filter,threshold,agent_behavior,semantic_query,learned_positive_count')
    .eq('workspace_id', ws)
    .order('owner_id');
  if (subs.error) throw subs.error;
  for (const s of subs.data ?? []) {
    console.log(`${s.active ? 'ON ' : 'OFF'} | ${s.owner_id} | thresh=${s.threshold} | behavior=${s.agent_behavior} | filter=${JSON.stringify(s.structured_filter)} | learned_n=${s.learned_positive_count}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
