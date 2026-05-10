/**
 * Concurrency benchmark runner: agent-crm side.
 *
 * 50 parallel writers each assert a unique fact about the same account.
 * Append-only events + content-hashed facts: zero conflicts expected.
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

const CONCURRENCY = 50;
const ACCOUNT_NAME = 'Resona Labs';
const PREDICATE = 'concurrency_test';
const RUN_TAG = `concur_${Date.now().toString(36)}`;

async function findWorkspace(): Promise<string> {
  if (process.env.WS) return process.env.WS;
  const { data, error } = await supabase
    .from('workspaces')
    .select('id, created_at')
    .like('name', 'demo · agent-crm%')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  if (!data?.length) throw new Error('No demo workspace; run `pnpm seed` first.');
  return data[0]!.id as string;
}

async function findAccount(ws: string, name: string): Promise<string> {
  const r = await supabase
    .from('entities')
    .select('id')
    .eq('workspace_id', ws)
    .eq('kind', 'account')
    .eq('name', name)
    .single();
  if (r.error || !r.data) throw new Error(`account not found: ${name}`);
  return r.data.id as string;
}

async function assertFact(ws: string, accountId: string, writerN: number) {
  // Use the same pattern as the seed script: callTool via the events RPC. We
  // call the underlying record_event RPC directly here to keep dependencies tight.
  const { data, error } = await supabase.rpc('record_event', {
    p_workspace_id: ws,
    p_actor_kind: 'agent',
    p_actor_id: `concur_writer_${writerN}`,
    p_action: 'assert_fact',
    p_target_kind: 'fact',
    p_target_id: null,
    p_payload: {
      subject_entity: accountId,
      predicate: PREDICATE,
      object_text: `${RUN_TAG}_${writerN}`,
      confidence: 0.9,
    },
    p_prompt_hash: null,
    p_parent_event_id: null,
  });
  if (error) throw error;
  return data;
}

async function main() {
  const ws = await findWorkspace();
  const accountId = await findAccount(ws, ACCOUNT_NAME);
  console.log(`workspace: ${ws}\naccount:  ${accountId} (${ACCOUNT_NAME})\nrun_tag:  ${RUN_TAG}\n`);

  console.log(`firing ${CONCURRENCY} parallel writers…`);
  const t0 = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: CONCURRENCY }, (_, i) => assertFact(ws, accountId, i)),
  );
  const wall_ms = Date.now() - t0;
  const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
  const rejected = results.filter((r) => r.status === 'rejected');
  console.log(`  ${fulfilled} fulfilled, ${rejected.length} rejected, ${wall_ms} ms total`);
  if (rejected.length) {
    console.log('  rejection samples:', rejected.slice(0, 3).map((r: any) => r.reason?.message ?? r.reason));
  }

  // Read back: how many distinct facts with object_text starting with RUN_TAG persist?
  const persisted = await supabase
    .from('facts')
    .select('id, object_text')
    .eq('workspace_id', ws)
    .eq('subject_entity', accountId)
    .eq('predicate', PREDICATE)
    .like('object_text', `${RUN_TAG}_%`);
  if (persisted.error) throw persisted.error;
  const distinct = new Set((persisted.data ?? []).map((r) => r.object_text));

  const result = {
    system: 'agent-crm',
    concurrency: CONCURRENCY,
    facts_attempted: CONCURRENCY,
    facts_persisted: distinct.size,
    data_loss_count: CONCURRENCY - distinct.size,
    data_loss_pct: ((CONCURRENCY - distinct.size) / CONCURRENCY) * 100,
    wall_clock_ms: wall_ms,
    fulfilled,
    rejected: rejected.length,
    run_tag: RUN_TAG,
  };

  console.log(`\nagent-crm concurrency result:`);
  console.log(`  attempted:     ${result.facts_attempted}`);
  console.log(`  persisted:     ${result.facts_persisted}`);
  console.log(`  data loss:     ${result.data_loss_count} (${result.data_loss_pct.toFixed(1)}%)`);
  console.log(`  wall clock:    ${result.wall_clock_ms} ms`);

  mkdirSync(OUT_DIR, { recursive: true });
  const out = resolve(OUT_DIR, 'concurrency_agent-crm.json');
  writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(`\nwrote ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
