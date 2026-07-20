import { createClient } from '@supabase/supabase-js';

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

(async () => {
  const wsId = 'af602fa1-1e0b-4bee-9841-01894553e0a9';

  const { data: sources, error } = await db
    .from('sources')
    .select('id,name,connector_type,active,last_run_at,last_run_status,last_run_summary,created_at')
    .eq('workspace_id', wsId)
    .order('last_run_at', { ascending: false, nullsFirst: false });

  if (error) { console.error(error); process.exit(1); }

  const now = Date.now();
  console.log('\n=== SOURCES ===');
  for (const s of sources ?? []) {
    const age = s.last_run_at ? ((now - new Date(s.last_run_at).getTime()) / 3600000).toFixed(1) + 'h' : 'NEVER';
    console.log(`\n[${s.active ? 'ON ' : 'OFF'}] ${s.name}  (${s.connector_type})`);
    console.log(`   last_run: ${age} ago  status=${s.last_run_status}`);
    console.log(`   summary: ${typeof s.last_run_summary === 'object' ? JSON.stringify(s.last_run_summary) : s.last_run_summary}`);
  }

  const { data: sig } = await db
    .from('signals')
    .select('id,type,created_at,source_id')
    .eq('workspace_id', wsId)
    .order('created_at', { ascending: false })
    .limit(10);
  console.log('\n=== LAST 10 SIGNALS (created_at) ===');
  for (const s of sig ?? []) console.log(`   ${s.created_at}  ${s.type}  src=${s.source_id}`);

  const wk = new Date(now - 7 * 86400000).toISOString();
  const { count } = await db
    .from('signals')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', wsId)
    .gte('created_at', wk);
  console.log(`\nsignals created in last 7d: ${count}`);
})();
