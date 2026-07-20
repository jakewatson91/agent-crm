import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
async function main() {
  const { data } = await sb.from('events')
    .select('created_at, actor_id, payload')
    .eq('workspace_id', WS)
    .in('action', ['assert_fact', 'supersede_fact'])
    .eq('actor_id', 'default_enricher')
    .gte('created_at', '2026-07-14T02:15:00Z')
    .order('created_at', { ascending: true });
  const names = new Map<string, string>();
  for (const e of data ?? []) {
    const p = e.payload as { predicate?: string; object_text?: string; subject_entity?: string };
    if (!p.predicate || p.predicate.startsWith('score_') || p.predicate.startsWith('icp_fit')) continue;
    const subj = p.subject_entity ?? '';
    if (!names.has(subj)) {
      const { data: ent } = await sb.from('entities').select('name').eq('id', subj).single();
      names.set(subj, ent?.name ?? '?');
    }
    console.log(`[${names.get(subj)}] ${p.predicate} = ${(p.object_text ?? '').slice(0, 180)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
