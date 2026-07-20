import { config } from 'dotenv'; config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const ws='af602fa1-1e0b-4bee-9841-01894553e0a9';
(async()=>{
  const { data: ents } = await sb.from('entities').select('id, name, attributes, created_at').eq('workspace_id',ws).ilike('name','%google calendar%');
  for (const e of ents??[]) {
    console.log(`\nENTITY "${e.name}" (${e.id.slice(0,8)}) created=${String(e.created_at).slice(0,19)}`);
    console.log('  attributes:', JSON.stringify(e.attributes));
    const { data: isa } = await sb.from('facts').select('object_text').eq('subject_entity',e.id).eq('predicate','is_a').is('supersedes',null);
    console.log('  is_a:', JSON.stringify((isa??[]).map(r=>r.object_text)));
    const { data: own } = await sb.from('facts').select('predicate, object_text, signal_id').eq('subject_entity',e.id).is('supersedes',null);
    console.log('  facts where it is SUBJECT:', JSON.stringify((own??[]).map(f=>`${f.predicate}=${f.object_text}`)));
    const { data: asObj } = await sb.from('facts').select('subject_entity, predicate').eq('object_entity',e.id).is('supersedes',null).limit(10);
    console.log('  facts where it is OBJECT (who points to it):', (asObj??[]).length, JSON.stringify((asObj??[]).map(f=>`${f.subject_entity.slice(0,8)} ${f.predicate}`).slice(0,6)));
  }
  // how many entities look like tools/products, not companies? count by whether anything points to them as an edge object
  console.log('\n--- scope: how many entities were created as edge-objects (have object_entity facts pointing in)? ---');
})();
