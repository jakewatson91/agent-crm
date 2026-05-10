/**
 * Create the universal outbound_drafter subscription. Idempotent.
 * Replaces the 4 source-specific drafters (yc_outbound_drafter, audit_yc_drafter,
 * web_signal_drafter, icp_drafter_test). Filter is empty so it matches any signal;
 * the drafter prompt's icp_fit < 0.30 → off_icp gate is what filters out misses.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { embed, vectorLiteral } from '@agent-crm/primitives';

const NAME = 'outbound_drafter';
const OWNER = 'claims_outbound_drafter';
const SEMANTIC = 'a company worth drafting outbound to: high ICP fit, with recent news, signal, or hook worth referencing in the email';
const THRESHOLD = 0.40;

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const ws = await sb.from('workspaces').select('id, name').like('name', 'demo · agent-crm%')
    .order('created_at', { ascending: false }).limit(1).single();
  if (!ws.data) throw new Error('no workspace');
  const WS = ws.data.id as string;
  console.log(`workspace: ${ws.data.name}`);

  // Idempotent on (workspace_id, owner_id)
  const existing = await sb.from('subscriptions').select('id, name, active')
    .eq('workspace_id', WS).eq('owner_id', OWNER).maybeSingle();
  if (existing.data) {
    if (!existing.data.active) {
      await sb.from('subscriptions').update({ active: true }).eq('id', existing.data.id);
      console.log(`  reactivated existing: ${existing.data.name}`);
    } else {
      console.log(`  already exists, active: ${existing.data.name}`);
    }
    return;
  }

  console.log('  computing embedding…');
  const vec = await embed(SEMANTIC);
  const insert = await sb.from('subscriptions').insert({
    workspace_id: WS,
    owner_kind: 'agent',
    owner_id: OWNER,
    name: NAME,
    semantic_query: SEMANTIC,
    semantic_embedding: vectorLiteral(vec),
    structured_filter: {},
    threshold: THRESHOLD,
    action_on_match: 'agent.run',
    active: true,
    agent_behavior: 'drafter',
  }).select('id').single();
  if (insert.error) throw insert.error;
  console.log(`  ✓ created ${NAME} (${(insert.data?.id as string).slice(0, 8)}…)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
