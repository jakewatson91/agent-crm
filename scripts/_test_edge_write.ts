/**
 * Validates the Step 2 write path end-to-end (minus the LLM): resolve an
 * entity-typed object -> assert an object_entity edge -> graphProximity traverses
 * it. Uses a throwaway subject account and cleans it up after.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { act } from '@agent-crm/primitives';
import { resolveOrCreateEntity, graphProximity } from '@agent-crm/tools';

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`); cond ? pass++ : fail++; };

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = ((await sb.from('workspaces').select('id, name')).data ?? []).find((w) => (w.id as string).startsWith('af602fa1'))!.id as string;
  const actor = { workspace_id: ws, actor_kind: 'system' as const, actor_id: 'edge-write-test' };

  // pre-clean
  for (const e of ((await sb.from('entities').select('id').eq('workspace_id', ws).eq('name', 'Zzztest Edge Subject')).data ?? []) as Array<{ id: string }>) {
    await sb.from('facts').delete().eq('subject_entity', e.id);
    await sb.from('entities').delete().eq('id', e.id);
  }

  // 1. throwaway subject account
  const subj = await act(sb, actor, { tool: 'create_entity', args: { name: 'Zzztest Edge Subject', kind: 'account', attributes: {} } });
  const subjId = subj.target_id;

  // 2. resolve an entity-typed object (mirrors the enricher dispatch when the LLM tags object_type=account)
  const res = await resolveOrCreateEntity(sb, actor, { name: 'Notion', object_type: 'account', subject_entity: subjId });
  check('object "Notion" resolves to an entity', res.entity_id !== null, `${res.reason}`);

  // 3. write the edge exactly as the dispatch does
  if (res.entity_id) {
    await act(sb, actor, { tool: 'assert_fact', args: { subject_entity: subjId, predicate: 'customer_of', object_entity: res.entity_id, confidence: 0.9 } });
  }

  // 4. it's a real edge: graphProximity traverses subject -> Notion
  const gp = await graphProximity(sb, ws, subjId);
  check('graphProximity sees the new edge', gp.edge_count >= 1, `edge_count=${gp.edge_count} predicates=${JSON.stringify(gp.predicates)}`);

  // 5. the fact is an object_entity edge, not text
  const edge = (await sb.from('facts').select('object_entity, object_text, predicate').eq('workspace_id', ws).eq('subject_entity', subjId).eq('predicate', 'customer_of')).data?.[0] as any;
  check('edge fact has object_entity set, object_text null', edge && edge.object_entity === res.entity_id && edge.object_text === null, `object_entity=${edge?.object_entity?.slice(0, 8)}`);

  // cleanup
  await sb.from('facts').delete().eq('subject_entity', subjId);
  await sb.from('entities').delete().eq('id', subjId);
  console.log(`  cleaned up test subject ${subjId.slice(0, 8)}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
