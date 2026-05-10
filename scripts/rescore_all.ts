/**
 * One-shot: rescore every entity in the workspace. Use after a major ICP change
 * when waiting for the 30-min cron isn't acceptable. Idempotent via supersede.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { scoreAndAssert } from '@agent-crm/tools';

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const ws = await sb.from('workspaces').select('id, name')
    .like('name', 'demo · agent-crm%').order('created_at', { ascending: false }).limit(1).single();
  if (!ws.data) throw new Error('no workspace');
  const WS = ws.data.id as string;
  const actor = { workspace_id: WS, actor_kind: 'system' as const, actor_id: 'rescore_all_script' };
  console.log(`workspace: ${ws.data.name}`);

  // Pick entities that have at least one fact (no point scoring entities with nothing)
  const facts = await sb.from('facts').select('subject_entity').eq('workspace_id', WS).is('supersedes', null);
  const entityIds = [...new Set(((facts.data ?? []) as Array<{ subject_entity: string }>).map((r) => r.subject_entity))];
  console.log(`scoring ${entityIds.length} entities…`);

  let done = 0;
  for (const id of entityIds) {
    try {
      const r = await scoreAndAssert(sb, actor, id);
      done++;
      if (r) process.stdout.write('.');
    } catch (e) {
      process.stdout.write('x');
    }
    if (done % 50 === 0) process.stdout.write(` ${done}\n`);
  }
  console.log(`\n✓ ${done} entities scored`);
}
main().catch((e) => { console.error(e); process.exit(1); });
