import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
  // active is_a=account facts
  const acc = await sb.from('facts').select('subject_entity', { count: 'exact' })
    .eq('workspace_id', ws).eq('predicate', 'is_a').eq('object_text', 'account').is('supersedes', null);
  const accSet = new Set((acc.data ?? []).map((r:any)=>r.subject_entity));
  console.log('active accounts:', accSet.size, '(count head:', acc.count, ')');
  // how many accounts carry the 4 marker facts (the cleanup target / rescore set)
  for (const pred of ['research_triggered','research_completed','contacts_requested','contacts_completed']) {
    const r = await sb.from('facts').select('id', { count: 'exact', head: true })
      .eq('workspace_id', ws).eq('predicate', pred);
    console.log(`  ${pred}: ${r.count} rows total`);
  }
  // distinct accounts with any score_total (the realistic rescore set)
  const st = await sb.from('facts').select('subject_entity').eq('workspace_id', ws).eq('predicate','score_total').is('supersedes', null);
  console.log('accounts with a score_total:', new Set((st.data??[]).map((r:any)=>r.subject_entity)).size);
}
main().catch(e=>{console.error(e);process.exit(1);});
