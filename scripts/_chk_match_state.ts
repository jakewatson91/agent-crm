import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
async function main() {
  const { data: sigs } = await sb.from('signals').select('id, created_at, entity_id')
    .eq('workspace_id', WS).gte('created_at', '2026-07-14T01:45:00Z')
    .order('created_at', { ascending: true });
  console.log('signals created tonight:', sigs?.length ?? 0);
  const ids = (sigs ?? []).map((s) => s.id);
  const { data: matched } = await sb.from('events').select('target_id, created_at')
    .eq('workspace_id', WS).eq('action', 'subscription.matched').in('target_id', ids);
  console.log('of those, matched:', matched?.length ?? 0);
  const { data: recentMatch } = await sb.from('events').select('created_at, target_id')
    .eq('workspace_id', WS).eq('action', 'subscription.matched')
    .order('created_at', { ascending: false }).limit(3);
  for (const m of recentMatch ?? []) console.log('recent match:', m.created_at);
}
main().catch((e) => { console.error(e); process.exit(1); });
