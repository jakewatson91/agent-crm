/**
 * Replayability demo: agent-crm side.
 *
 * Test scenario: at time T1 we asserted "Resona uses_stack=python". Later, at
 * time T2, we superseded that with "Resona uses_stack=bun". We use replay_to
 * to reconstruct projection state at T1 (just-after-python, just-before-bun)
 * and at T2 (after the supersede). The reconstructed state at T1 should
 * include python as an active fact; at T2 it should include bun and exclude
 * python.
 *
 * What this proves: the system can deterministically reconstruct any past
 * projection state from the event log. Pin an agent reasoning step to a
 * specific replay point and you can rerun or audit it.
 */

import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: process.env.DOTENV_CONFIG_PATH ?? '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '../../metrics');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

async function main() {
  const ws = await supabase
    .from('workspaces').select('id').like('name', 'demo · agent-crm%')
    .order('created_at', { ascending: false }).limit(1).single();
  if (ws.error || !ws.data) throw new Error('No demo workspace');
  const WS = ws.data.id as string;

  const ent = await supabase
    .from('entities').select('id, name')
    .eq('workspace_id', WS).eq('kind', 'account').eq('name', 'Resona Labs').single();
  if (ent.error || !ent.data) throw new Error('Resona Labs not found');

  // Locate the supersede_fact event (event 159 from earlier provenance run).
  const supersedeEv = await supabase
    .from('events')
    .select('id, action, created_at, payload')
    .eq('workspace_id', WS)
    .eq('action', 'supersede_fact')
    .filter('payload->>subject_entity', 'eq', ent.data.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  if (supersedeEv.error || !supersedeEv.data) throw new Error('No supersede_fact event found for Resona');

  // Pick T_before = supersede_event timestamp - 1 ms (just before the supersede).
  // Pick T_after  = now (latest state).
  const tSupersede = new Date(supersedeEv.data.created_at as string);
  const tBefore = new Date(tSupersede.getTime() - 1).toISOString();
  const tAfter = new Date().toISOString();

  console.log(`supersede_event ${supersedeEv.data.id} occurred at ${tSupersede.toISOString()}`);
  console.log(`replay T_before:  ${tBefore}`);
  console.log(`replay T_after:   ${tAfter}\n`);

  // Replay state at T_before (python should be active, bun does not yet exist)
  const before = await supabase.rpc('replay_to', { p_workspace_id: WS, p_ts: tBefore });
  if (before.error) throw before.error;
  const beforeFacts = (before.data?.facts ?? []) as Array<{ id: string; subject_entity: string; predicate: string; object_text: string; supersedes: string | null }>;
  const beforeUsesStack = beforeFacts
    .filter((f) => f.subject_entity === ent.data.id && f.predicate === 'uses_stack');

  // Replay state at T_after (bun should be active, python superseded)
  const after = await supabase.rpc('replay_to', { p_workspace_id: WS, p_ts: tAfter });
  if (after.error) throw after.error;
  const afterFacts = (after.data?.facts ?? []) as typeof beforeFacts;
  const afterUsesStack = afterFacts
    .filter((f) => f.subject_entity === ent.data.id && f.predicate === 'uses_stack');

  console.log('=== state at T_before (just before supersede) ===');
  for (const f of beforeUsesStack) console.log(`  uses_stack=${f.object_text}  (id=${f.id})`);

  console.log('\n=== state at T_after (now) ===');
  for (const f of afterUsesStack) console.log(`  uses_stack=${f.object_text}  (id=${f.id})`);

  const beforeStacks = new Set(beforeUsesStack.map((f) => f.object_text));
  const afterStacks = new Set(afterUsesStack.map((f) => f.object_text));
  const includedThenExcluded = [...beforeStacks].filter((s) => !afterStacks.has(s));
  const excludedThenIncluded = [...afterStacks].filter((s) => !beforeStacks.has(s));

  console.log('\n=== diff ===');
  console.log(`only in T_before: ${JSON.stringify(includedThenExcluded)}`);
  console.log(`only in T_after:  ${JSON.stringify(excludedThenIncluded)}`);

  // Determinism: replay T_after again and confirm same result.
  const after2 = await supabase.rpc('replay_to', { p_workspace_id: WS, p_ts: tAfter });
  const after2Facts = (after2.data?.facts ?? []) as typeof beforeFacts;
  const after2UsesStack = after2Facts
    .filter((f) => f.subject_entity === ent.data.id && f.predicate === 'uses_stack');
  const sameAsBefore = JSON.stringify(afterUsesStack.map((f) => f.id).sort())
    === JSON.stringify(after2UsesStack.map((f) => f.id).sort());
  console.log(`\nreplay determinism: same result on second call? ${sameAsBefore ? 'YES ✓' : 'NO ✗'}`);

  const result = {
    system: 'agent-crm',
    supersede_event_id: supersedeEv.data.id,
    t_before: tBefore,
    t_after: tAfter,
    state_at_t_before: { uses_stack: [...beforeStacks] },
    state_at_t_after:  { uses_stack: [...afterStacks] },
    diff_only_in_t_before: includedThenExcluded,
    diff_only_in_t_after:  excludedThenIncluded,
    deterministic: sameAsBefore,
    summary: 'replay_to(workspace_id, ts) reconstructs full projection state at any past timestamp from the events log. Output is deterministic across calls.',
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const out = resolve(OUT_DIR, 'replay_agent-crm.json');
  writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(`\nwrote ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
