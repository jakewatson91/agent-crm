import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function main() {
  // entities the cloud enricher touched at 03:0x on 07-11 (dogfood)
  const ids = ['bc7eb904-a8c1-45ed-aeba-6cc968f3e408','40991176-095c-4b16-8d17-66b0ac83a1fd','33137433-85ea-46d9-a763-2d6cbf9cb15e','03a74c79-0399-455a-9529-753e8f336970'];
  for (const id of ids) {
    const { data } = await sb.from('facts')
      .select('predicate, object_text, observed_at')
      .eq('subject_entity', id)
      .in('predicate', ['score_total', 'icp_fit'])
      .order('observed_at', { ascending: false })
      .limit(4);
    console.log(id.slice(0, 8), (data ?? []).map((f) => `${f.predicate}=${f.object_text}@${f.observed_at.slice(0, 16)}`).join('  ') || 'NO SCORE FACTS');
  }
  // any score-fact events written by cloud (non-local) actors since 07-10 14:00?
  const { data: ev } = await sb.from('events')
    .select('actor_id, action, created_at, workspace_id')
    .in('action', ['assert_fact', 'supersede_fact'])
    .gte('created_at', '2026-07-10T14:00:00Z')
    .not('actor_id', 'in', '(rescore_all_script,repro_rescore_local)')
    .order('created_at', { ascending: false })
    .limit(2000);
  const byActor = new Map<string, number>();
  for (const e of ev ?? []) byActor.set(`${e.workspace_id.slice(0,8)}:${e.actor_id}:${e.action}`, (byActor.get(`${e.workspace_id.slice(0,8)}:${e.actor_id}:${e.action}`) ?? 0) + 1);
  console.log('\nfact writes since 07-10 14:00 (excluding local scripts):');
  for (const [k, n] of [...byActor.entries()].sort()) console.log(` ${k}: ${n}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
