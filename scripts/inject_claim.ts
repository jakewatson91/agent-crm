/**
 * Demonstrates Moltbook-style claim subscriptions.
 *
 * Adds a brand-new saved filter rule to a running workspace with an arbitrary owner_id.
 * The database doesn't know what this owner is, doesn't care, doesn't need a code change.
 * Pre-existing signals that match its filter are routed to it on the next match cycle;
 * we also synthesize one fresh signal so you can refresh the UI and see the new claim
 * post within seconds.
 *
 * Usage: WS=<workspace_id> pnpm inject
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { embed, vectorLiteral, subscribe } from '@agent-crm/primitives';
import { callTool } from '@agent-crm/tools';

const WS = process.env.WS;
if (!WS) {
  console.error('set WS=<workspace_id>  (printed by `pnpm seed`)');
  process.exit(1);
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

// A saved filter rule that did not exist a moment ago. Owner_id is arbitrary text.
const NEW_CLAIM = `claims_pricing_page_diff_${Math.random().toString(36).slice(2, 6)}`;

async function main() {
  const actor = { workspace_id: WS!, actor_kind: 'agent' as const, actor_id: NEW_CLAIM };

  console.log(`registering new claim: ${NEW_CLAIM}`);
  const sub = await subscribe(supabase, actor, {
    owner_kind: 'agent',
    owner_id: NEW_CLAIM,
    name: 'pricing_page_changes_b2b',
    filter: {
      semantic: 'pricing page changes or new tier announcements at B2B SaaS companies',
      structured: { signal_source: 'pricing_page' },
      threshold: 0.35,
      action: 'agent.run',
    },
  });
  console.log(`  → subscription ${sub.subscription_id.slice(0, 8)} registered`);

  // Pick the first b2b_saas account to attach the synthetic signal + post to.
  const { data: ents } = await supabase
    .from('entities')
    .select('id, name, attributes')
    .eq('workspace_id', WS!)
    .eq('kind', 'account')
    .limit(20);
  const target = (ents ?? []).find((e) => (e.attributes as { industry?: string })?.industry === 'b2b_saas');
  if (!target) throw new Error('no b2b_saas account found in workspace');

  console.log(`  injecting fresh signal on ${target.name}`);
  await callTool(supabase, { workspace_id: WS!, actor_kind: 'agent', actor_id: 'ingest:pricing_page' }, 'create_signal', {
    entity_id: target.id,
    type: 'pricing_page_diff',
    magnitude: 0.78,
    body_for_embedding: `${target.name} added a new "Enterprise" tier on their pricing page with custom SSO and SLA.`,
    structured_tags: { industry: 'b2b_saas', signal_source: 'pricing_page' },
  });

  // Post directly to the channel so the demo is visible without an Inngest dev server.
  const { data: chan } = await supabase
    .from('channels').select('id')
    .eq('workspace_id', WS!).eq('account_entity_id', target.id).single();
  if (chan?.id) {
    await callTool(supabase, actor, 'post_to_channel', {
      channel_id: chan.id,
      kind: 'claim',
      body: `${target.name} just shipped an Enterprise tier — pricing page diff suggests they\'re moving upmarket. Worth a touch.`,
      cites: [],
    });
  }

  console.log(`\n✓ ${NEW_CLAIM} is now part of the workspace`);
  console.log('  refresh /activity or the channel to see its post');
  console.log('  no role was registered, no enum updated, no code redeployed');
}

main().catch((e) => { console.error(e); process.exit(1); });
