import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function main() {
  const { count } = await sb.from('events').select('id', { count: 'exact', head: true })
    .eq('workspace_id', 'e7052848-2270-41ac-90b6-d9b75c87f6d3')
    .in('action', ['assert_fact', 'supersede_fact'])
    .in('actor_id', ['default_enricher', 'relevant_hires_enricher'])
    .gte('created_at', '2026-07-14T01:45:00Z');
  console.log(count ?? 0);
}
main().catch(() => { console.log(''); process.exit(1); });
