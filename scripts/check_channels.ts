import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function main() {
  // Try inserting a test channel to see what columns are required
  const ws = await sb.from('workspaces').select('id').like('name', 'demo · agent-crm%').order('created_at', { ascending: false }).limit(1).single();
  const wsId = ws.data!.id;
  const ent = await sb.from('entities').select('id').eq('workspace_id', wsId).eq('kind', 'account').eq('name', '11x.ai').single();
  console.log('ws:', wsId, 'acc:', ent.data!.id);
  // Sample a few channels to see schema
  const sample = await sb.from('channels').select('*').limit(2);
  console.log('sample channels columns:', sample.data && sample.data[0] ? Object.keys(sample.data[0]) : 'empty');
  console.log('sample channel:', JSON.stringify(sample.data?.[0], null, 2));
  // Look for any channel referencing 11x.ai
  const acc = ent.data!.id;
  const byAcc = await sb.from('channels').select('id, kind, title, account_entity_id, workspace_id').or(`account_entity_id.eq.${acc}`);
  console.log('byAcc:', JSON.stringify(byAcc.data, null, 2), 'error:', byAcc.error?.message);
}
main();
