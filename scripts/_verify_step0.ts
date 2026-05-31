import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { excludeSuperseded } from '@agent-crm/primitives';
import { graphProximity } from '@agent-crm/tools';

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = ((await sb.from('workspaces').select('id, name')).data ?? []).find((w) => (w.id as string).startsWith('af602fa1'))!.id as string;
  const ent = (await sb.from('entities').select('id, name').eq('workspace_id', ws).ilike('name', 'Scheduling Wizard').limit(1)).data?.[0] as any;
  console.log(`subject: ${ent?.name} (${ent?.id?.slice(0, 8)})\n`);

  // 1. The supersede fix: active read must return the LATEST score, not the stale original.
  const pred = 'score_signal_strength';
  const all = (await sb.from('facts').select('id, object_text, supersedes, observed_at')
    .eq('workspace_id', ws).eq('subject_entity', ent.id).eq('predicate', pred)).data ?? [];
  const active = await excludeSuperseded(sb, ws, all as Array<{ id: string }>);
  const buggy = (await sb.from('facts').select('object_text')
    .eq('workspace_id', ws).eq('subject_entity', ent.id).eq('predicate', pred).is('supersedes', null)).data ?? [];

  console.log(`${pred}:`);
  console.log(`  all versions:        ${(all as any[]).map((r) => r.object_text).join(', ')}`);
  console.log(`  excludeSuperseded -> ${(active as any[]).map((r) => r.object_text).join(', ')}   (should be the LATEST)`);
  console.log(`  OLD .is(null) ->     ${(buggy as any[]).map((r) => r.object_text).join(', ')}   (the STALE original the bug returned)`);

  const newest = (all as any[]).slice().sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at))[0]?.object_text;
  const pass1 = (active as any[]).length === 1 && (active as any[])[0].object_text === newest;
  console.log(`  PASS: ${pass1}\n`);

  // 2. graphProximity runs end-to-end without error on the rewritten path.
  const gp = await graphProximity(sb, ws, ent.id);
  console.log(`graphProximity(Scheduling Wizard): ${JSON.stringify(gp)}`);
  console.log(`  PASS (no throw, shape ok): ${typeof gp.score === 'number' && typeof gp.edge_count === 'number'}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
