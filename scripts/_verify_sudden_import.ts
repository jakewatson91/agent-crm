import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = '7c4f79b1-518f-4e64-b634-f61aa14b88d2';

async function main() {
  // 1. Spot-check Stingray Group
  const acct = await sb.from('entities').select('id, name, attributes').eq('workspace_id', WS).ilike('name', '%stingray%');
  console.log('=== Stingray accounts ===', JSON.stringify(acct.data, null, 2));
  if (acct.data?.[0]) {
    const facts = await sb.from('facts').select('predicate, object_text').eq('workspace_id', WS).eq('subject_entity', acct.data[0].id).is('supersedes', null);
    console.log('facts:', JSON.stringify(facts.data, null, 2));
    const worksAt = await sb.from('facts').select('subject_entity').eq('workspace_id', WS).eq('predicate', 'works_at').eq('object_entity', acct.data[0].id);
    console.log('linked contacts (subject_entity ids):', JSON.stringify(worksAt.data));
  }

  // 2. any duplicate account names?
  const all = await sb.from('entities').select('name').eq('workspace_id', WS);
  const nameCounts = new Map<string, number>();
  for (const e of (all.data ?? []) as Array<{ name: string }>) {
    nameCounts.set(e.name, (nameCounts.get(e.name) ?? 0) + 1);
  }
  const dupes = [...nameCounts.entries()].filter(([, c]) => c > 1);
  console.log(`\ntotal entities: ${all.data?.length}, duplicate names: ${dupes.length}`);
  if (dupes.length) console.log(dupes.slice(0, 20));
}
main().catch((e) => { console.error(e); process.exit(1); });
