import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import exaContacts from '../inngest/functions/sources/connectors/exa_contacts.ts';

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const w = ((await sb.from('workspaces').select('id').limit(50)).data ?? []).find((x:any)=> String(x.id).startsWith('af602fa1')) as any;
  const workspace_id = w.id;
  const ctx = { supabase: sb, workspace_id, source_id: 'test1234-0000-0000-0000-000000000000', config: { max_contacts: 3, min_account_fit: 0.6, cooldown_hours: 0 }, last_run_at: null };
  const t = Date.now();
  const res = await exaContacts(ctx as any);
  console.log(`\nresult in ${Date.now()-t}ms:`, JSON.stringify(res));
  // show the web_activity facts just created
  const f = (await sb.from('facts').select('subject_entity, object_text, observed_at').eq('workspace_id', workspace_id).eq('predicate','web_activity').order('observed_at',{ascending:false}).limit(3)).data;
  for (const x of f ?? []) {
    const ent = (await sb.from('entities').select('name').eq('id', x.subject_entity).maybeSingle()).data;
    console.log(`\n  ${ent?.name}: ${String(x.object_text).slice(0,200)}`);
    const sig = (await sb.from('facts').select('object_text, observed_at').eq('workspace_id',workspace_id).eq('subject_entity',x.subject_entity).eq('predicate','score_signal_strength').order('observed_at',{ascending:false}).limit(1)).data?.[0];
    console.log(`    -> signal_strength now: ${sig?.object_text}`);
  }
}
main().catch((e)=>{console.error('ERR:', e.message, e.stack);});
