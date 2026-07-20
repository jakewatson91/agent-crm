import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
async function main() {
  const { data } = await sb.from('facts')
    .select('subject_entity, predicate, object_text, confidence, observed_at')
    .eq('workspace_id', WS)
    .gte('observed_at', '2026-07-14T01:45:00Z')
    .order('observed_at', { ascending: true });
  const names = new Map<string, string>();
  for (const f of data ?? []) {
    if (!names.has(f.subject_entity)) {
      const { data: e } = await sb.from('entities').select('name').eq('id', f.subject_entity).single();
      names.set(f.subject_entity, e?.name ?? '?');
    }
    console.log(`[${names.get(f.subject_entity)}] ${f.predicate} = ${(f.object_text ?? '').slice(0, 150)}  (conf ${f.confidence})`);
  }
  console.log(`\ntotal: ${data?.length ?? 0}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
