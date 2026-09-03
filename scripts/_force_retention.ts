import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { runRetention } from '@agent-crm/tools';

/** Run retention now on every workspace, ignoring the ~daily throttle. */
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function main() {
  const ws = await sb.from('workspaces').select('id, name').order('name');
  for (const w of (ws.data ?? []) as Array<{ id: string; name: string }>) {
    const r = await runRetention(sb, w.id, { force: true });
    console.log(`  ${w.name}: facts=${r.fact_history_pruned} events=${r.events_pruned} embeddings=${r.embeddings_archived}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
