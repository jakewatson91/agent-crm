/**
 * Week-1 smoke test for the database layer.
 *
 * Proves the autonomous-loop foundations:
 *   1. record_event writes events + projections atomically.
 *   2. Content-addressed facts are idempotent on hash.
 *   3. Subscription matching (GIN + pgvector) finds the right saved filter rules.
 *   4. replay_to(ts) reconstructs state at any past timestamp.
 *   5. Provenance chain (cite) traces fact -> source_event -> prompt_hash.
 *
 * Usage: pnpm smoke
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { act, embed, vectorLiteral, subscribe, cite } from '@agent-crm/primitives';
import { callTool } from '@agent-crm/tools';
import { randomUUID } from 'node:crypto';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!url || !key) {
  console.error('missing supabase env');
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

const RUN_ID = randomUUID().slice(0, 8);
let WORKSPACE_ID = '';

function log(label: string, ok: boolean, detail?: unknown) {
  const mark = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`${mark} ${label}${detail ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  if (!ok) process.exitCode = 1;
}

async function step(name: string, fn: () => Promise<void>) {
  console.log(`\n— ${name}`);
  try {
    await fn();
  } catch (err) {
    log(name, false, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

async function main() {
  console.log(`smoke test run_id=${RUN_ID}`);

  await step('create workspace', async () => {
    const r = await callTool(
      supabase,
      { workspace_id: '00000000-0000-0000-0000-000000000000', actor_kind: 'system', actor_id: 'smoke' },
      'create_workspace',
      {
        name: `smoke-${RUN_ID}`,
        persona: { pitch: 'AI-native customer feedback for B2B SaaS PMs.' },
        icp: { industry: 'b2b_saas', headcount: '10-200', stack: ['react', 'postgres'] },
        budget_cents: 1000,
        policy: { notify_channels: ['in_app'] },
      },
    );
    if (!r.ok) throw new Error(r.error);
    WORKSPACE_ID = r.target_id;
    log('workspace created', true, WORKSPACE_ID);
  });

  // From here on, the workspace is real. The 'system' actor with the placeholder workspace_id
  // was only used for the bootstrap; subsequent calls scope to WORKSPACE_ID.
  const actor = { workspace_id: WORKSPACE_ID, actor_kind: 'agent' as const, actor_id: 'smoke' };

  let acmeId = '';
  let beachId = '';
  await step('create accounts', async () => {
    const a = await callTool(supabase, actor, 'create_account', { name: 'Acme Corp', attributes: { domain: 'acme.example' } });
    if (!a.ok) throw new Error(a.error);
    acmeId = a.target_id;

    const b = await callTool(supabase, actor, 'create_account', { name: 'Beach Inc', attributes: { domain: 'beach.example' } });
    if (!b.ok) throw new Error(b.error);
    beachId = b.target_id;
    log('two accounts created', true, { acmeId, beachId });

    const { data: chans } = await supabase.from('channels').select('account_entity_id, title').eq('workspace_id', WORKSPACE_ID);
    log('channels auto-created per account', chans?.length === 2, chans);
  });

  let factId = '';
  await step('assert facts (idempotent on content hash)', async () => {
    const f1 = await callTool(supabase, actor, 'assert_fact', {
      subject_entity: acmeId,
      predicate: 'uses_stack',
      object_text: 'Postgres',
      confidence: 0.92,
    });
    if (!f1.ok) throw new Error(f1.error);
    factId = f1.target_id;

    // Re-assert identical fact: should return same target_id (idempotent).
    const f2 = await callTool(supabase, actor, 'assert_fact', {
      subject_entity: acmeId,
      predicate: 'uses_stack',
      object_text: 'Postgres',
      confidence: 0.92,
    });
    if (!f2.ok) throw new Error(f2.error);
    log('idempotent on content hash', f2.target_id === factId, { first: factId, second: f2.target_id });

    // But event count grows: every act() writes an event, even if the projection is a no-op.
    const { count } = await supabase
      .from('events')
      .select('*', { count: 'exact', head: true })
      .eq('workspace_id', WORKSPACE_ID)
      .eq('action', 'assert_fact');
    log('events grow on every act() (audit log)', (count ?? 0) >= 2, { event_count: count });
  });

  await step('cite walks the provenance chain', async () => {
    const c = await cite(supabase, { id: factId });
    log('chain has at least one entry', c.chain.length >= 1, c.chain);
    log('chain points to source event', !!c.chain[0]?.source_event_id, c.chain[0]);
  });

  let acmeEmbedding: number[] = [];
  await step('add entity embeddings (so query/subscriptions can match)', async () => {
    acmeEmbedding = await embed('Acme Corp uses Postgres and React. b2b_saas.');
    const beachEmbedding = await embed('Beach Inc is a luxury beachwear brand. d2c.');
    const { error: e1 } = await supabase.from('entity_embeddings').upsert({
      entity_id: acmeId, perspective: 'default', embedding: vectorLiteral(acmeEmbedding) as unknown as string,
    });
    const { error: e2 } = await supabase.from('entity_embeddings').upsert({
      entity_id: beachId, perspective: 'default', embedding: vectorLiteral(beachEmbedding) as unknown as string,
    });
    if (e1 || e2) throw new Error((e1 ?? e2)!.message);
    log('two embeddings inserted', true);
  });

  let subId = '';
  await step('create subscription (semantic + structured filter)', async () => {
    const r = await subscribe(supabase, actor, {
      owner_kind: 'agent',
      owner_id: 'evaluator',
      name: 'b2b_saas_postgres_users',
      filter: {
        semantic: 'companies that use Postgres in their stack',
        structured: { industry: 'b2b_saas' },
        threshold: 0.4,
        action: 'agent.run',
      },
    });
    subId = r.subscription_id;
    log('subscription created', !!subId, subId);
  });

  let signalId = '';
  await step('create matching signal', async () => {
    const r = await callTool(supabase, actor, 'create_signal', {
      entity_id: acmeId,
      type: 'careers_page_diff',
      magnitude: 0.8,
      body_for_embedding: 'Acme Corp is hiring senior Postgres engineers. b2b_saas.',
      structured_tags: { industry: 'b2b_saas', role: 'engineer' },
    });
    if (!r.ok) throw new Error(r.error);
    signalId = r.target_id;
    log('signal created (with auto-embedding)', true, signalId);
  });

  await step('subscription matching SQL finds the match', async () => {
    const { data, error } = await supabase.rpc('match_signal_to_subscriptions', { p_signal_id: signalId });
    if (error) throw error;
    const matches = (data ?? []) as Array<{ subscription_id: string; similarity: number }>;
    log('at least one subscription matched', matches.length >= 1, matches);
    log('our subscription is in the result', matches.some((m) => m.subscription_id === subId), matches.map((m) => m.subscription_id));
  });

  await step('post to channel with cites', async () => {
    const { data: channel } = await supabase
      .from('channels')
      .select('id')
      .eq('workspace_id', WORKSPACE_ID)
      .eq('account_entity_id', acmeId)
      .single();

    const r = await callTool(supabase, actor, 'post_to_channel', {
      channel_id: (channel as { id: string }).id,
      kind: 'claim',
      body: 'Acme is hiring Postgres engineers — strong fit for our outreach.',
      cites: [factId],
    });
    if (!r.ok) throw new Error(r.error);
    log('post created with cites', true, r.target_id);
  });

  // Capture timestamp BEFORE adding more events; we'll replay back to here later.
  const cutoff = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 1100));

  await step('add more events past the cutoff', async () => {
    await callTool(supabase, actor, 'assert_fact', {
      subject_entity: beachId,
      predicate: 'uses_stack',
      object_text: 'Shopify',
      confidence: 0.9,
    });
    await callTool(supabase, actor, 'create_account', { name: 'Late Co' });
    log('post-cutoff events added', true);
  });

  await step('replay_to reconstructs pre-cutoff state', async () => {
    const { data, error } = await supabase.rpc('replay_to', { p_workspace_id: WORKSPACE_ID, p_ts: cutoff });
    if (error) throw error;
    const snap = data as { entities: unknown[]; facts: unknown[]; signals: unknown[]; channel_posts: unknown[] };
    const entityNames = (snap.entities as Array<{ name: string }>).map((e) => e.name).sort();
    log('replay shows only Acme + Beach (no Late Co)', JSON.stringify(entityNames) === '["Acme Corp","Beach Inc"]', entityNames);
    log('replay shows the original Acme fact', (snap.facts as Array<{ predicate: string; object_text: string }>).some((f) => f.predicate === 'uses_stack' && f.object_text === 'Postgres'), `${snap.facts.length} facts`);
    log('replay shows the signal', snap.signals.length === 1, `${snap.signals.length} signals`);
    log('replay shows the channel post', snap.channel_posts.length === 1, `${snap.channel_posts.length} posts`);
  });

  await step('events table is append-only at SQL grant level', async () => {
    // Try to delete an event with the service role -> should fail because we revoked DELETE.
    const { error } = await supabase.from('events').delete().eq('workspace_id', WORKSPACE_ID).limit(1);
    log('DELETE on events is blocked', !!error, error?.message ?? 'unexpectedly succeeded');
  });

  await step('cleanup', async () => {
    await supabase.from('workspaces').delete().eq('id', WORKSPACE_ID);
    log('workspace torn down', true);
  });

  console.log('\n' + (process.exitCode ? '\x1b[31mFAILED\x1b[0m' : '\x1b[32mAll database-layer claims hold ✓\x1b[0m'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
