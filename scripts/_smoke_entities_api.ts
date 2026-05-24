import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

  // Pull 5 entity ids from the demo workspace, get their is_a facts.
  const { data: ents } = await sb.from('entities').select('id, name, kind').limit(5);
  if (!ents) { console.log('no entities'); return; }
  const ids = ents.map((e: any) => e.id);
  const { data: tf } = await sb.from('facts').select('subject_entity, object_text')
    .eq('predicate', 'is_a').is('supersedes', null).in('subject_entity', ids);
  const byEnt = new Map<string, string[]>();
  for (const f of (tf ?? []) as any[]) {
    const arr = byEnt.get(f.subject_entity) ?? [];
    arr.push(f.object_text);
    byEnt.set(f.subject_entity, arr);
  }
  console.log('entity_id | name | column.kind | is_a fact types');
  for (const e of ents as any[]) {
    console.log(' ', e.id.slice(0, 8), '|', e.name.slice(0, 30), '|', e.kind, '|', byEnt.get(e.id) ?? []);
  }
  console.log('\nDual-state check: every row should have kind matching the is_a fact.');
}
main().catch(e => { console.error(e); process.exit(1); });
