/**
 * List all subscriptions in the workspace as a quick sanity check.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  let WS = process.env.WS;
  if (!WS) {
    const { data } = await supabase.from('workspaces').select('id').like('name','demo · agent-crm%').order('created_at',{ascending:false}).limit(1).single();
    WS = data!.id as string;
  }
  const { data } = await supabase
    .from('subscriptions')
    .select('owner_id, name, semantic_query, structured_filter, threshold, active, created_at')
    .eq('workspace_id', WS)
    .order('created_at', { ascending: false });
  console.log(`subscriptions in workspace ${WS}:\n`);
  for (const s of data ?? []) {
    console.log(`  ${(s.owner_id as string).padEnd(45)}  thr=${s.threshold}  ${(s.name as string).padEnd(38)}  filter=${JSON.stringify(s.structured_filter)}`);
    console.log(`    "${s.semantic_query}"`);
  }
  console.log(`\ntotal: ${data?.length ?? 0}`);
}
main();
