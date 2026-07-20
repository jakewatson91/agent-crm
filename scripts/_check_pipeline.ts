import { createClient } from '@supabase/supabase-js';
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const ws = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
(async () => {
  const since = new Date(Date.now() - 2*3600*1000).toISOString();
  const { data: sig } = await db.from('signals').select('id,type,created_at,entity_id').eq('workspace_id', ws).gte('created_at', since).order('created_at',{ascending:false});
  console.log(`signals last 2h: ${sig?.length ?? 0}`);
  for (const s of (sig??[]).slice(0,8)) console.log(`  ${s.created_at} ${s.type} ent=${s.entity_id?.slice(0,8)}`);
  const { data: ev } = await db.from('events').select('action,actor_kind,actor_id,created_at').eq('workspace_id', ws).gte('created_at', since).order('created_at',{ascending:false}).limit(15);
  console.log(`\nevents last 2h: ${ev?.length ?? 0}`);
  const byAction: Record<string,number> = {};
  for (const e of ev??[]) byAction[e.action] = (byAction[e.action]??0)+1;
  console.log('  by action:', JSON.stringify(byAction));
  const { data: facts } = await db.from('facts').select('id,predicate,created_at').eq('workspace_id', ws).gte('created_at', since).order('created_at',{ascending:false}).limit(10);
  console.log(`\nfacts created last 2h: ${facts?.length ?? 0}`);
  for (const f of (facts??[]).slice(0,8)) console.log(`  ${f.created_at} ${f.predicate}`);
})();
