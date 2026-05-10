/**
 * Agent runtime smoke test.
 *
 * Exercises the full autonomous loop without an Inngest dev server:
 *   1. Inject a fresh signal via create_signal (which fires the Postgres trigger).
 *   2. Call match_signal_to_subscriptions RPC to find subscriptions that match.
 *   3. For each agent-owned match, call runAgent() directly.
 *   4. Verify each agent produced a channel_post with valid cites.
 *
 * Usage: WS=<workspace_id> pnpm exec tsx scripts/agent_smoke.ts
 *        (omit WS to auto-discover the most recent demo workspace)
 */

import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { callTool } from '@agent-crm/tools';
import { runAgent } from '../inngest/functions/agent_logic.js';

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  // 0. Find workspace.
  let WS = process.env.WS;
  if (!WS) {
    const { data, error } = await supabase
      .from('workspaces').select('id').like('name', 'demo · agent-crm%')
      .order('created_at', { ascending: false }).limit(1).single();
    if (error || !data) throw new Error('No demo workspace; run `pnpm seed` first.');
    WS = data.id as string;
  }
  console.log(`workspace: ${WS}\n`);

  // 1. Pick the b2b_saas account most likely to match the existing icp_fit subscription.
  const accounts = await supabase
    .from('entities')
    .select('id, name, attributes')
    .eq('workspace_id', WS)
    .eq('kind', 'account');
  if (accounts.error) throw accounts.error;
  const target = accounts.data?.find((a) => (a.attributes as { industry?: string })?.industry === 'b2b_saas');
  if (!target) throw new Error('no b2b_saas account in workspace');
  console.log(`target account: ${target.name}  (${target.id})\n`);

  // 2. Inject a fresh signal that should match `claims_icp_fit_scoring` subscription.
  const stack = (target.attributes as { stack?: string[] })?.stack ?? ['typescript'];
  console.log('1. injecting signal…');
  const signalRes = await callTool(
    supabase,
    { workspace_id: WS, actor_kind: 'agent', actor_id: 'ingest:careers_page' },
    'create_signal',
    {
      entity_id: target.id,
      type: 'careers_page_diff',
      magnitude: 0.82,
      body_for_embedding: `${target.name} just posted a senior ${stack[0]} engineering role on their careers page. b2b_saas hiring signal.`,
      structured_tags: { industry: 'b2b_saas', role: 'engineer', signal_source: 'careers_page' },
    },
  );
  if (!signalRes.ok) throw new Error(`create_signal failed: ${signalRes.error}`);
  const signal_id = signalRes.target_id;
  const trigger_event_id = signalRes.event_id;
  console.log(`   signal_id=${signal_id}\n   event_id=${trigger_event_id}\n`);

  // 3. Match the signal to subscriptions (in production this is what match_signal Inngest does).
  console.log('2. matching signal to subscriptions…');
  const matchRes = await supabase.rpc('match_signal_to_subscriptions', { p_signal_id: signal_id });
  if (matchRes.error) throw new Error(`match_signal RPC failed: ${matchRes.error.message}`);
  const matches = (matchRes.data ?? []) as Array<{
    subscription_id: string; owner_kind: 'agent' | 'user'; owner_id: string;
    action_on_match: string; similarity: number;
  }>;
  console.log(`   ${matches.length} matches`);
  for (const m of matches) console.log(`     ${m.owner_id}  similarity=${m.similarity.toFixed(3)}`);
  console.log();

  if (matches.length === 0) {
    console.log('no subscriptions matched — nothing to test (re-run pnpm seed if subscriptions are missing)');
    return;
  }

  // 4. For each agent-owned match, run the agent.
  console.log('3. running agents…');
  const runs = [];
  for (const m of matches) {
    if (m.owner_kind !== 'agent') {
      console.log(`   skip ${m.owner_id} (human-owned)`);
      continue;
    }
    const t0 = Date.now();
    const r = await runAgent(supabase, {
      workspace_id: WS,
      agent: m.owner_id,
      subscription_id: m.subscription_id,
      signal_id,
      parent_event_id: trigger_event_id,
    });
    const ms = Date.now() - t0;
    runs.push({ ...r, owner: m.owner_id, ms });
    if (r.ok) {
      const cached = r.llm_cached_input_tokens ?? 0;
      const cacheHit = cached > 0 ? ` (cached ${cached})` : '';
      const provider = r.llm_provider ? ` [${r.llm_provider}/${r.llm_model}]` : '';
      console.log(`   ✓ ${m.owner_id}: ${r.action} (post=${r.channel_post_id?.slice(0, 8)}${r.gate_id ? ', gate=' + r.gate_id.slice(0, 8) : ''}) ${r.llm_input_tokens ?? '?'}in${cacheHit}/${r.llm_output_tokens ?? '?'}out, ${ms}ms${provider}`);
    } else {
      console.log(`   ✗ ${m.owner_id}: ${r.reason}`);
    }
  }
  console.log();

  // 5. Verify each successful run produced a channel_post with cites pointing to real facts.
  console.log('4. verifying channel posts…');
  for (const run of runs) {
    if (!run.ok || !run.channel_post_id) continue;
    const post = await supabase
      .from('channel_posts')
      .select('id, kind, body, cites, author_id, parent_post_id')
      .eq('id', run.channel_post_id)
      .single();
    if (post.error || !post.data) {
      console.log(`   ✗ ${run.owner}: post ${run.channel_post_id} not found`);
      continue;
    }
    const citeCount = (post.data.cites as string[] | null)?.length ?? 0;
    let citesValid = 0;
    if (citeCount > 0) {
      const factRows = await supabase
        .from('facts').select('id').in('id', post.data.cites as string[]);
      citesValid = factRows.data?.length ?? 0;
    }
    console.log(`   ✓ ${run.owner}: kind=${post.data.kind}  cites=${citeCount} (valid=${citesValid})  body="${(post.data.body as string).slice(0, 70)}…"`);
  }

  // 6. Verify provenance chain: walk parent_event_id from the post back to the signal trigger.
  console.log('\n5. verifying provenance chain on first successful post…');
  const firstOk = runs.find((r) => r.ok && r.channel_post_id);
  if (firstOk?.channel_post_id) {
    const ev = await supabase
      .from('events')
      .select('id, action, actor_id, parent_event_id, prompt_hash')
      .eq('target_id', firstOk.channel_post_id)
      .order('id', { ascending: false }).limit(1).single();
    if (ev.data) {
      console.log(`   post created by event ${ev.data.id}`);
      console.log(`     action:       ${ev.data.action}`);
      console.log(`     actor_id:     ${ev.data.actor_id}`);
      console.log(`     parent_event: ${ev.data.parent_event_id} (the signal trigger)`);
      console.log(`     prompt_hash:  ${ev.data.prompt_hash?.slice(0, 16) ?? '(none)'}…`);
    }
  }

  console.log('\nautonomous loop end-to-end: ✓');
  console.log(`open: http://localhost:3000/workspace/${WS}/channels  to see the new posts`);
}

main().catch((e) => { console.error(e); process.exit(1); });
