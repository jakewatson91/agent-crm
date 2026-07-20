import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

async function main() {
  const { data: workspaces } = await sb.from('workspaces').select('id, name, policy, created_at').order('created_at', { ascending: false }).limit(10);
  console.log('=== workspaces ===');
  for (const w of workspaces ?? []) {
    console.log(w.id, w.name, w.created_at);
  }

  const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
  const { data: sudden } = await sb.from('workspaces').select('*').eq('id', WS).maybeSingle();
  if (!sudden) {
    console.log('\nSudden workspace NOT FOUND at', WS);
    return;
  }
  console.log('\n=== Sudden workspace row ===');
  console.log('name:', sudden.name);
  console.log('policy:', JSON.stringify(sudden.policy, null, 2));

  const acct = await sb.from('facts').select('id', { count: 'exact', head: true }).eq('workspace_id', WS).eq('predicate','is_a').eq('object_text','account');
  const contact = await sb.from('facts').select('id', { count: 'exact', head: true }).eq('workspace_id', WS).eq('predicate','is_a').eq('object_text','contact');
  const sig = await sb.from('signals').select('id', { count: 'exact', head: true }).eq('workspace_id', WS);
  const entities = await sb.from('entities').select('id', { count: 'exact', head: true }).eq('workspace_id', WS);
  console.log('\naccounts:', acct.count, 'contacts:', contact.count, 'signals:', sig.count, 'entities:', entities.count);

  const { data: subs } = await sb.from('subscriptions').select('id, owner_kind, owner_id, name, agent_behavior, threshold, action_on_match').eq('workspace_id', WS);
  console.log('\n=== subscriptions ===');
  console.log(JSON.stringify(subs, null, 2));

  const { data: srcs } = await sb.from('sources').select('id, name, kind, active, config').eq('workspace_id', WS);
  console.log('\n=== sources ===');
  console.log(JSON.stringify(srcs, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
