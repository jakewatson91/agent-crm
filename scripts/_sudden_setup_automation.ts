/**
 * One-time bootstrap: bring Sudden (e7052848-2270-41ac-90b6-d9b75c87f6d3) up
 * to the same automation level as dogfood. See
 * ~/.claude/plans/squishy-imagining-harp.md for the full plan/reasoning.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { callTool } from '@agent-crm/tools';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const actor = { workspace_id: WS, actor_kind: 'system' as const, actor_id: 'sudden_setup_script' };

async function main() {
  // 1. Generic catchall enricher — mirrors the auto-create fix now shipped in
  // apps/web/app/api/workspaces/create/route.ts, seeded by hand here since
  // that fix doesn't apply retroactively.
  const enricherSub = await callTool(sb, actor, 'create_subscription', {
    owner_kind: 'agent',
    owner_id: 'default_enricher',
    name: 'default_enricher',
    semantic_query: 'new information about a prospective account worth recording as facts — news, product changes, funding, hiring, technology, or anything relevant to fit',
    structured_filter: {},
    threshold: 0.30,
    action_on_match: 'agent.run',
  });
  if (enricherSub.ok) {
    await sb.from('subscriptions').update({ agent_behavior: 'enricher' }).eq('id', enricherSub.target_id);
    console.log('✓ default_enricher subscription created:', enricherSub.target_id);
  } else {
    console.log('✗ default_enricher subscription failed:', enricherSub.error);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
