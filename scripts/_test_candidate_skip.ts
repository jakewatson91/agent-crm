/**
 * Step 5 guard: scoreEntity must skip candidate entities (return null) before
 * doing any scoring work, so a thin node never gets a meaningless score.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { act } from '@agent-crm/primitives';
import { scoreEntity } from '@agent-crm/tools';

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = ((await sb.from('workspaces').select('id, name')).data ?? []).find((w) => (w.id as string).startsWith('af602fa1'))!.id as string;
  const actor = { workspace_id: ws, actor_kind: 'system' as const, actor_id: 'candidate-skip-test' };

  for (const e of ((await sb.from('entities').select('id').eq('workspace_id', ws).eq('name', 'Zzztest Candidate Acct')).data ?? []) as Array<{ id: string }>) {
    await sb.from('facts').delete().eq('subject_entity', e.id);
    await sb.from('entities').delete().eq('id', e.id);
  }

  // candidate account (is_a=account, attributes.candidate=true)
  const cand = await act(sb, actor, { tool: 'create_entity', args: { name: 'Zzztest Candidate Acct', kind: 'account', attributes: { candidate: true } } });
  const score = await scoreEntity(sb, ws, cand.target_id);
  const ok = score === null;
  console.log(`scoreEntity(candidate) => ${score === null ? 'null' : JSON.stringify(score).slice(0, 60)}`);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  candidate is skipped by scoring`);

  await sb.from('facts').delete().eq('subject_entity', cand.target_id);
  await sb.from('entities').delete().eq('id', cand.target_id);
  console.log(`  cleaned up ${cand.target_id.slice(0, 8)}`);
  if (!ok) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
