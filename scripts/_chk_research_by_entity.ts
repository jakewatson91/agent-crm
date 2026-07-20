import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
async function main() {
  const { data } = await sb.from('events').select('created_at, payload, target_id')
    .eq('workspace_id', WS).eq('action', 'research_completed')
    .gte('created_at', '2026-07-14T01:45:00Z')
    .order('created_at', { ascending: false });
  for (const e of data ?? []) {
    const { data: ent } = await sb.from('entities').select('name').eq('id', e.target_id!).single();
    console.log(e.created_at.slice(11, 19), ent?.name, '—', (e.payload as Record<string, unknown>)?.summary);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
