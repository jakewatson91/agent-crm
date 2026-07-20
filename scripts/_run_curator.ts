import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { getSourceMetrics } from '@agent-crm/tools';

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const wsId = 'af602fa1-1e0b-4bee-9841-01894553e0a9';

  const m7 = await getSourceMetrics(sb, wsId, 24 * 7);
  console.log('Source metrics (7d):');
  for (const m of m7) {
    console.log(`  ${m.name} active=${m.active} signals=${m.signals} agent_fire_rate=${m.agent_fire_rate} fact_yield=${m.fact_yield}`);
  }
}

main().catch(console.error);
