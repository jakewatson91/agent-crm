import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function main() {
  const { data, error } = await sb.from('sources').select('*').eq('workspace_id', 'e7052848-2270-41ac-90b6-d9b75c87f6d3');
  if (error) { console.log('ERROR:', error.message); return; }
  for (const s of data ?? []) {
    console.log(JSON.stringify({ id: s.id, name: s.name, connector_type: s.connector_type, active: s.active, schedule_cron: s.schedule_cron, last_run_at: s.last_run_at, last_run_summary: s.last_run_summary, config: s.config }).slice(0, 500));
  }
  console.log('total sources:', data?.length ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
