import { createClient } from '@supabase/supabase-js';
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const ws = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
(async () => {
  const since = new Date(Date.now() - 90*60*1000).toISOString();
  const { data } = await db.from('events').select('created_at,action,actor_kind,actor_id,payload').eq('workspace_id', ws).gte('created_at', since).order('created_at',{ascending:false}).limit(25);
  console.log(`events last 90m: ${data?.length ?? 0}`);
  for (const e of data ?? []) {
    const p = JSON.stringify(e.payload ?? {}).slice(0,160);
    console.log(`  ${e.created_at}  ${e.action}  by ${e.actor_id}  ${p}`);
  }
})();
