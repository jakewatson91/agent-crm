/**
 * Step 3: an edge with a COINED relationship type (never in the old
 * EDGE_PREDICATES list) must now be traversed by graphProximity.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { act } from '@agent-crm/primitives';
import { graphProximity } from '@agent-crm/tools';

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = ((await sb.from('workspaces').select('id, name')).data ?? []).find((w) => (w.id as string).startsWith('af602fa1'))!.id as string;
  const actor = { workspace_id: ws, actor_kind: 'system' as const, actor_id: 'open-vocab-test' };
  const notion = (await sb.from('entities').select('id').eq('workspace_id', ws).eq('name', 'Notion').limit(1)).data?.[0] as { id: string };

  for (const e of ((await sb.from('entities').select('id').eq('workspace_id', ws).eq('name', 'Zzztest Vocab Subject')).data ?? []) as Array<{ id: string }>) {
    await sb.from('facts').delete().eq('subject_entity', e.id);
    await sb.from('entities').delete().eq('id', e.id);
  }
  const subj = await act(sb, actor, { tool: 'create_entity', args: { name: 'Zzztest Vocab Subject', kind: 'account', attributes: {} } });

  // a coined predicate that was NOT in the old hardcoded list
  await act(sb, actor, { tool: 'assert_fact', args: { subject_entity: subj.target_id, predicate: 'rivals_with', object_entity: notion.id, confidence: 0.9 } });

  const gp = await graphProximity(sb, ws, subj.target_id);
  const ok = gp.edge_count >= 1 && !!gp.predicates['rivals_with'];
  console.log(`graphProximity: ${JSON.stringify(gp)}`);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  coined predicate "rivals_with" is traversed`);

  await sb.from('facts').delete().eq('subject_entity', subj.target_id);
  await sb.from('entities').delete().eq('id', subj.target_id);
  console.log(`  cleaned up ${subj.target_id.slice(0, 8)}`);
  if (!ok) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
