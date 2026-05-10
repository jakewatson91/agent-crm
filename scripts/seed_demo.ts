/**
 * Seeds a demo workspace using Moltbook-style claim subscriptions.
 *
 * No fixed roles. Every "agent" is just a saved filter rule with an owner_id that
 * describes what it grabs, not what role it plays. The database doesn't know what
 * a "drafter" or "critic" is — it just routes matching signals to whichever saved
 * filter rule grabbed them first/best.
 *
 * Owner naming convention: `claims_<what_the_subscription_grabs>`.
 * Adding a new "agent" = creating a new subscription. No code change, no role table.
 *
 * Usage: pnpm seed
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { embed, vectorLiteral, subscribe } from '@agent-crm/primitives';
import { callTool } from '@agent-crm/tools';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const ACCOUNTS = [
  { name: 'Resona Labs',    pitch: 'AI voice analytics for sales calls.',          stack: ['typescript','postgres','python'], industry: 'b2b_saas' },
  { name: 'Forge Robotics', pitch: 'Autonomous mobile robots for warehouses.',     stack: ['rust','ros2','postgres'],         industry: 'industrial' },
  { name: 'Plaintext.so',   pitch: 'Email-first CRM for indie hackers.',           stack: ['elixir','postgres'],              industry: 'b2b_saas' },
  { name: 'Halo Health',    pitch: 'Care coordination platform for primary care.', stack: ['ruby','postgres','react'],        industry: 'healthtech' },
  { name: 'Brightvine',     pitch: 'AI shopping assistant for wine retailers.',    stack: ['python','postgres','react'],      industry: 'd2c' },
  { name: 'Strand Compute', pitch: 'GPU spot pricing arbitrage for ML teams.',     stack: ['go','rust','postgres'],           industry: 'infra' },
] as const;

// Claim-shaped owner ids. Each is a saved filter rule that grabs a kind of signal,
// not a role with a job title. They can overlap; the database doesn't enforce
// "one role per task."
const CLAIM = {
  new_accounts:     'claims_new_b2b_accounts',
  account_facts:    'claims_account_facts',
  icp_fit:          'claims_icp_fit_scoring',
  outreach_drafts:  'claims_outreach_drafts',
  unsourced_drafts: 'claims_unsourced_drafts',
  release_signals:  'claims_github_release_signals',
} as const;

async function main() {
  console.log('seeding demo workspace…');

  // Delete prior demo workspace(s) so we don't clutter the dashboard.
  await supabase.from('workspaces').delete().like('name', 'demo · agent-crm%');

  const ws = await callTool(
    supabase,
    { workspace_id: '00000000-0000-0000-0000-000000000000', actor_kind: 'system', actor_id: 'seed' },
    'create_workspace',
    {
      name: 'demo · agent-crm',
      persona: { pitch: 'AI-native customer feedback platform that auto-clusters support tickets into product themes for B2B SaaS PMs.' },
      icp: { industry: 'b2b_saas', headcount: '10-200', stack: ['react','postgres','typescript'], pain: ['ticket triage','feature request signal'] },
      budget_cents: 1500,
      policy: { notify_channels: ['in_app'] },
    },
  );
  if (!ws.ok) throw new Error(ws.error);
  const WS = ws.target_id;
  const actor = (id: string) => ({ workspace_id: WS, actor_kind: 'agent' as const, actor_id: id });
  console.log(`  workspace_id = ${WS}`);

  // === Accounts ===
  // Created by the subscription that claims "new b2b accounts in our ICP".
  const accounts: Array<{ id: string; name: string }> = [];
  for (const a of ACCOUNTS) {
    const r = await callTool(supabase, actor(CLAIM.new_accounts), 'create_account', {
      name: a.name,
      attributes: { domain: a.name.toLowerCase().replace(/[^a-z]+/g, '') + '.example', industry: a.industry, stack: a.stack, pitch: a.pitch },
    });
    if (!r.ok) throw new Error(r.error);
    accounts.push({ id: r.target_id, name: a.name });
    const vec = await embed(`${a.name}: ${a.pitch} stack=${a.stack.join(',')} industry=${a.industry}`);
    await supabase.from('entity_embeddings').upsert({
      entity_id: r.target_id,
      perspective: 'default',
      embedding: vectorLiteral(vec) as unknown as string,
    });
  }
  console.log(`  ${accounts.length} accounts created (by ${CLAIM.new_accounts})`);

  // === Facts ===
  // Asserted by the subscription that claims "fact extraction on new accounts".
  const factIds: Record<string, string[]> = {};
  for (const a of accounts) {
    const acct = ACCOUNTS.find((x) => x.name === a.name)!;
    factIds[a.id] = [];
    for (const tech of acct.stack) {
      const f = await callTool(supabase, actor(CLAIM.account_facts), 'assert_fact', {
        subject_entity: a.id,
        predicate: 'uses_stack',
        object_text: tech,
        confidence: 0.9,
      });
      if (f.ok) factIds[a.id].push(f.target_id);
    }
    const fpitch = await callTool(supabase, actor(CLAIM.account_facts), 'assert_fact', {
      subject_entity: a.id,
      predicate: 'pitch',
      object_text: acct.pitch,
      confidence: 0.95,
    });
    if (fpitch.ok) factIds[a.id].push(fpitch.target_id);
  }

  // Supersede chain on Resona to give cite() depth.
  const resona = accounts.find((x) => x.name === 'Resona Labs')!;
  const pyFact = await supabase
    .from('facts').select('id')
    .eq('subject_entity', resona.id)
    .eq('predicate', 'uses_stack').eq('object_text', 'python').single();
  if (pyFact.data?.id) {
    await callTool(supabase, actor(CLAIM.account_facts), 'supersede_fact', {
      subject_entity: resona.id,
      predicate: 'uses_stack',
      object_text: 'bun',
      confidence: 0.85,
      supersedes: pyFact.data.id,
    });
  }
  console.log(`  facts asserted (by ${CLAIM.account_facts}, with one supersede on Resona)`);

  // === Signals ===
  // Real signals would arrive via webhooks/cron; for the demo we synthesize them
  // and let the subscription matcher route them to whoever's saved filter rule grabs them.
  for (const a of accounts.slice(0, 4)) {
    const acct = ACCOUNTS.find((x) => x.name === a.name)!;
    await callTool(supabase, actor('ingest:careers_page'), 'create_signal', {
      entity_id: a.id,
      type: 'careers_page_diff',
      magnitude: 0.7 + Math.random() * 0.25,
      body_for_embedding: `${a.name} is hiring senior engineers in ${acct.stack[0]}. ${acct.industry}.`,
      structured_tags: { industry: acct.industry, role: 'engineer', signal_source: 'careers_page' },
    });
  }
  await callTool(supabase, actor('ingest:github'), 'create_signal', {
    entity_id: accounts[2].id,
    type: 'github_release',
    magnitude: 0.6,
    body_for_embedding: 'Plaintext.so released v2.3 with AI thread summarization',
    structured_tags: { industry: 'b2b_saas', signal_source: 'github' },
  });
  console.log('  5 signals created (ingest workers — also just claim-shaped owners)');

  // === Subscriptions ===
  // Each is a saved filter rule. owner_id describes what it grabs.
  await subscribe(supabase, actor(CLAIM.icp_fit), {
    owner_kind: 'agent',
    owner_id: CLAIM.icp_fit,
    name: 'b2b_saas_hiring_engineers',
    filter: {
      semantic: 'companies hiring engineers in B2B SaaS',
      structured: { industry: 'b2b_saas' },
      threshold: 0.4,
      action: 'agent.run',
    },
  });
  await subscribe(supabase, actor(CLAIM.release_signals), {
    owner_kind: 'agent',
    owner_id: CLAIM.release_signals,
    name: 'product_release_signals',
    filter: {
      semantic: 'product release or version bump',
      structured: { signal_source: 'github' },
      threshold: 0.4,
      action: 'agent.run',
    },
  });
  console.log('  2 subscriptions registered (the claims)');

  // === Channel posts ===
  // Posts byline'd by the *claim*, not by a role.
  const { data: chans } = await supabase.from('channels').select('id, account_entity_id').eq('workspace_id', WS);
  const chanByAcct = Object.fromEntries((chans ?? []).map((c) => [c.account_entity_id as string, c.id as string]));

  for (const a of accounts) {
    const cid = chanByAcct[a.id];
    if (!cid) continue;
    await callTool(supabase, actor(CLAIM.icp_fit), 'post_to_channel', {
      channel_id: cid,
      kind: 'claim',
      body: `${a.name} matches ICP. Hiring signal + stack overlap. Recommend outreach.`,
      cites: factIds[a.id]?.slice(0, 2) ?? [],
    });
  }

  // Drafter → critic thread on Resona. Two different claims, one channel post each.
  const resonaChan = chanByAcct[resona.id];
  if (resonaChan) {
    const root = await callTool(supabase, actor(CLAIM.outreach_drafts), 'post_to_channel', {
      channel_id: resonaChan,
      kind: 'touch_draft',
      body: 'Subject: noticed your Bun migration — quick question on PM workflow\n\nHi {first_name}, saw the team moved off Python. Curious how the PM team handles ticket triage now — that\'s the part we\'ve been obsessing over.',
      cites: factIds[resona.id]?.slice(0, 1) ?? [],
    });
    if (root.ok) {
      await callTool(supabase, actor(CLAIM.unsourced_drafts), 'post_to_channel', {
        channel_id: resonaChan,
        kind: 'decision',
        body: 'Cleared by claims_unsourced_drafts: every claim in this draft has a cite, no banned phrases, suppression list clean, within rate limit.',
        parent_post_id: root.target_id,
        thread_root_id: root.target_id,
      });
    }
  }
  console.log(`  channel posts attributed to claim subscriptions (not roles)`);

  // === Gates ===
  const halo = accounts.find((x) => x.name === 'Halo Health')!;
  const haloChan = chanByAcct[halo.id];
  const haloPost = await callTool(supabase, actor(CLAIM.outreach_drafts), 'post_to_channel', {
    channel_id: haloChan,
    kind: 'gate_request',
    body: 'Touch draft for Halo mentions HIPAA. Flagged: claim about HIPAA compliance has no fact citation.',
    cites: [],
  });
  if (haloPost.ok) {
    await callTool(supabase, actor(CLAIM.unsourced_drafts), 'request_gate', {
      channel_post_id: haloPost.target_id,
      policy: 'unsourced_claim',
      condition: { reason: 'unsourced HIPAA claim in draft', confidence: 0.41 },
    });
  }

  const brightvine = accounts.find((x) => x.name === 'Brightvine')!;
  const bvChan = chanByAcct[brightvine.id];
  const bvPost = await callTool(supabase, actor(CLAIM.outreach_drafts), 'post_to_channel', {
    channel_id: bvChan,
    kind: 'gate_request',
    body: 'Outreach to Brightvine would be the 51st send today. Daily ceiling exceeded.',
    cites: [],
  });
  if (bvPost.ok) {
    await callTool(supabase, actor('claims_rate_limits'), 'request_gate', {
      channel_post_id: bvPost.target_id,
      policy: 'rate_limit_exceeded',
      condition: { sends_today: 51, ceiling: 50 },
    });
  }

  // Decided gate (Strand)
  const strand = accounts.find((x) => x.name === 'Strand Compute')!;
  const strandChan = chanByAcct[strand.id];
  const sPost = await callTool(supabase, actor(CLAIM.outreach_drafts), 'post_to_channel', {
    channel_id: strandChan,
    kind: 'gate_request',
    body: 'Draft references unverified pricing claim. Awaiting human confirm.',
    cites: [],
  });
  if (sPost.ok) {
    const g = await callTool(supabase, actor(CLAIM.unsourced_drafts), 'request_gate', {
      channel_post_id: sPost.target_id,
      policy: 'unverified_claim',
      condition: { claim: 'Strand offers 80% spot discount' },
    });
    if (g.ok) {
      await supabase.from('gates').update({
        decided_by: null, decision: 'reject', decided_at: new Date().toISOString(),
      }).eq('id', g.target_id);
    }
  }
  console.log('  3 gates: 2 pending (different claim owners), 1 decided');

  console.log('\n✓ seed complete\n');
  console.log(`  open: http://localhost:3000/workspace/${WS}/gates`);
  console.log(`  also: http://localhost:3000/workspace/${WS}/activity`);
  console.log(`        http://localhost:3000/workspace/${WS}/channels`);
  console.log(`        http://localhost:3000/workspace/${WS}/query`);
  console.log(`        http://localhost:3000/workspace/${WS}/replay`);
  console.log(`\n  to watch a brand-new claim show up live:`);
  console.log(`    WS=${WS} pnpm inject`);
}

main().catch((e) => { console.error(e); process.exit(1); });
