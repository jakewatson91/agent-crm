import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
async function main() {
  // email facts on contacts
  const { data: emails } = await sb.from('facts')
    .select('subject_entity, predicate, object_text')
    .eq('workspace_id', WS).eq('predicate', 'email').limit(5);
  console.log('email facts sample:', JSON.stringify(emails, null, 1));
  const { count: emailCount } = await sb.from('facts').select('id', { count: 'exact', head: true })
    .eq('workspace_id', WS).eq('predicate', 'email');
  const { count: worksAt } = await sb.from('facts').select('id', { count: 'exact', head: true })
    .eq('workspace_id', WS).eq('predicate', 'works_at');
  console.log('email facts:', emailCount, ' works_at facts:', worksAt);
  // sample a contact entity's attributes too
  const { data: worksSample } = await sb.from('facts')
    .select('subject_entity, object_entity')
    .eq('workspace_id', WS).eq('predicate', 'works_at').limit(3);
  for (const w of worksSample ?? []) {
    const { data: c } = await sb.from('entities').select('name, attributes').eq('id', w.subject_entity).single();
    const { data: a } = await sb.from('entities').select('name, attributes').eq('id', w.object_entity!).single();
    console.log(`contact "${c?.name}" attrs=${JSON.stringify(c?.attributes)?.slice(0,200)}`);
    console.log(`  -> account "${a?.name}" attrs=${JSON.stringify(a?.attributes)?.slice(0,140)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
