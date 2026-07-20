import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function main() {
  const { data: workspaces } = await sb.from('workspaces').select('id, name, updated_at');
  console.log('workspace scan order (as returned, same as cron):');
  for (const ws of workspaces ?? []) {
    const { count: stale } = await sb.from('facts')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', ws.id).eq('predicate', 'icp_fit')
      .is('supersedes', null)
      .lt('observed_at', ws.updated_at);
    console.log(`  ${ws.id.slice(0,8)} ${ws.name}: updated_at=${ws.updated_at.slice(0,16)} stale_icp_fit=${stale}`);
  }
  // First workspace with stale rows wins all 50 slots. Take its 50 oldest and
  // classify why scoreAndAssert might return null.
  for (const ws of workspaces ?? []) {
    const { data: stale } = await sb.from('facts')
      .select('subject_entity, observed_at')
      .eq('workspace_id', ws.id).eq('predicate', 'icp_fit')
      .is('supersedes', null)
      .lt('observed_at', ws.updated_at)
      .order('observed_at', { ascending: true })
      .limit(50);
    if (!stale?.length) continue;
    console.log(`\ncron would pick 50 from: ${ws.name} (${ws.id.slice(0,8)})`);
    const ids = stale.map((r) => r.subject_entity);
    const { data: ents } = await sb.from('entities').select('id, name, attributes').in('id', ids);
    let candidateFlag = 0;
    for (const e of ents ?? []) if ((e.attributes as Record<string, unknown>)?.candidate) candidateFlag++;
    const { data: drops } = await sb.from('facts').select('subject_entity, object_text, supersedes')
      .eq('workspace_id', ws.id).eq('predicate', 'dropped_until').in('subject_entity', ids);
    const activeDrops = new Set((drops ?? []).filter((d) => !d.supersedes && d.object_text && Date.parse(d.object_text) > Date.now()).map((d) => d.subject_entity));
    const { data: isa } = await sb.from('facts').select('subject_entity, object_text')
      .eq('workspace_id', ws.id).eq('predicate', 'is_a').in('subject_entity', ids);
    const types = new Map<string, string[]>();
    for (const f of isa ?? []) {
      const arr = types.get(f.subject_entity) ?? []; arr.push(f.object_text as string); types.set(f.subject_entity, arr);
    }
    console.log(`  candidate-flagged: ${candidateFlag}/50, active dropped_until: ${activeDrops.size}/50`);
    const typeCount = new Map<string, number>();
    for (const id of ids) typeCount.set((types.get(id) ?? ['NONE']).join('+'), (typeCount.get((types.get(id) ?? ['NONE']).join('+')) ?? 0) + 1);
    console.log(`  is_a distribution:`, Object.fromEntries(typeCount));
    console.log(`  oldest 5:`, (ents ?? []).slice(0, 5).map((e) => e.name).join(', '));
    break;
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
