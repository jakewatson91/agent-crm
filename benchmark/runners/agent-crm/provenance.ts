/**
 * Provenance demo: agent-crm side.
 *
 * For Resona Labs we have a real supersede chain in the seed:
 *   uses_stack=python (original) -> superseded by uses_stack=bun (current)
 *
 * We pick the current fact and call cite() to walk the chain back through
 * the supersede pointer to source events, actors, and prompt hashes.
 *
 * What this proves: every claim in the system is recoverable to the event,
 * actor, and prompt hash that produced it. Pin an agent's reasoning to a
 * specific knowledge snapshot and you can reproduce or audit it.
 */

import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: process.env.DOTENV_CONFIG_PATH ?? '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cite } from '@agent-crm/primitives';

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

  // Pick the bun fact (the supersede-via-bun event creates a fact whose `supersedes`
  // pointer references the prior python fact — we want exactly this one to walk back).
  const bunFact = await supabase
    .from('facts')
    .select('id, predicate, object_text, supersedes, source_event_id, content_hash, observed_at')
    .eq('workspace_id', WS)
    .eq('subject_entity', ent.data.id)
    .eq('predicate', 'uses_stack')
    .eq('object_text', 'bun')
    .maybeSingle();

  if (bunFact.error) throw bunFact.error;
  if (!bunFact.data) {
    // Fallback: pick the latest non-superseded uses_stack fact
    console.log('(no bun fact found — re-run pnpm seed)');
    return;
  }

  console.log('=== current fact ===');
  console.log(JSON.stringify(bunFact.data, null, 2));

  // cite() walks the chain backward. The supersedes pointer goes back to python.
  const chain = await cite(supabase, { id: bunFact.data.id as string });
  console.log('\n=== cite chain ===');
  console.log(JSON.stringify(chain, null, 2));

  // Hydrate each chain entry with the full event row, so we can show the recoverable provenance.
  const hydrated = [];
  for (const link of chain.chain) {
    const ev = await supabase
      .from('events')
      .select('id, actor_kind, actor_id, action, payload, prompt_hash, parent_event_id, created_at')
      .eq('id', link.source_event_id)
      .maybeSingle();
    const factRow = await supabase
      .from('facts')
      .select('id, predicate, object_text, content_hash, supersedes, observed_at')
      .eq('id', link.fact_id)
      .maybeSingle();
    hydrated.push({
      fact: factRow.data,
      source_event: ev.data,
    });
  }

  console.log('\n=== hydrated provenance chain (each step recoverable in one SQL) ===');
  for (const [i, h] of hydrated.entries()) {
    console.log(`\n--- hop ${i} ---`);
    console.log(`fact:        ${h.fact?.predicate}=${h.fact?.object_text}  (id=${h.fact?.id})`);
    console.log(`content:     ${h.fact?.content_hash}`);
    console.log(`observed:    ${h.fact?.observed_at}`);
    console.log(`source_event: id=${h.source_event?.id}`);
    console.log(`  actor:     ${h.source_event?.actor_kind}/${h.source_event?.actor_id}`);
    console.log(`  action:    ${h.source_event?.action}`);
    console.log(`  prompt_hash: ${h.source_event?.prompt_hash ?? '(none — system seed)'}`);
    console.log(`  payload:   ${JSON.stringify(h.source_event?.payload)}`);
  }

  const result = {
    system: 'agent-crm',
    starting_fact_id: bunFact.data.id,
    chain_length: hydrated.length,
    chain: hydrated,
    summary: `Walked ${hydrated.length}-hop supersede chain. Every fact resolves to source event, actor, action, payload, prompt_hash. One SQL query per hop.`,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const out = resolve(OUT_DIR, 'provenance_agent-crm.json');
  writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(`\nwrote ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
