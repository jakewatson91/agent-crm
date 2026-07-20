import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { getPipelineStatus, setPipelineStatus } from '@agent-crm/tools';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
async function main() {
  const s = await getPipelineStatus(sb, WS);
  if (s?.state !== 'paused') { console.log('not paused:', JSON.stringify(s)); return; }
  await setPipelineStatus(sb, WS, { state: 'ok', last_run_at: s.last_run_at, last_run: s.last_run });
  console.log('pause cleared (was:', s.scope, '/', s.provider, ')');
}
main().catch((e) => { console.error(e); process.exit(1); });
