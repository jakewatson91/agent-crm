/**
 * Create the "relevant hires" subscription for the demo workspace.
 *
 * The semantic_query is a plain-English description the workspace owner would
 * write. For agent-crm (sells to small sales teams), the relevant hires are
 * sales/GTM/automation roles — but this exact text isn't in the connector
 * code anywhere. Same connector + same subscription machinery, different
 * workspace would write a different query (devtools → platform/infra hires,
 * vertical SaaS → industry-operations hires).
 *
 * structured_filter narrows by signal type before semantic matching runs.
 */
import { createServerClient } from '@agent-crm/db';
import { callTool } from '@agent-crm/tools';

const WS_ID = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
const OWNER_ID = 'relevant_hires_enricher';

const SEMANTIC_QUERY = [
  'Hiring posts that indicate the company is building or scaling their go-to-market motion.',
  'Roles we want to catch: founding sales hire, first AE/SDR/BDR, head of sales, VP sales, GTM engineer,',
  'sales automation, revenue operations, growth lead, business development, customer success leadership,',
  'go-to-market leader, founding GTM, sales engineer for outbound automation.',
  'Roles we do NOT want: engineering hires unrelated to sales tooling, firmware, hardware, design,',
  'finance, legal, HR, generic content/marketing without sales angle.',
].join(' ');

async function main() {
  const sb = createServerClient();

  // Idempotent: skip if already created
  const existing = await sb.from('subscriptions').select('id')
    .eq('workspace_id', WS_ID).eq('owner_id', OWNER_ID).maybeSingle();
  if (existing.data) { console.log('subscription already exists:', existing.data.id); return; }

  const actor = { workspace_id: WS_ID, actor_kind: 'system' as const, actor_id: 'setup:relevance_sub' };
  const created = await callTool(sb, actor, 'create_subscription', {
    owner_kind: 'agent',
    owner_id: OWNER_ID,
    name: 'Relevant hires (GTM/sales/automation)',
    semantic_query: SEMANTIC_QUERY,
    structured_filter: { type: 'hiring_post' },
    threshold: 0.5,
    action_on_match: 'agent.run',
  });
  if (!created.ok) { console.error('create failed:', created.error); return; }
  console.log('created subscription:', created.target_id);

  // Set agent_behavior='enricher' (same post-create-update pattern as
  // fix_signal_coverage.ts:83 — the tool schema doesn't expose this field yet).
  const upd = await sb.from('subscriptions').update({ agent_behavior: 'enricher' })
    .eq('id', created.target_id).select('id, name, threshold, agent_behavior, structured_filter');
  console.log('updated:', upd.data);
}

main().catch((e) => { console.error(e); process.exit(1); });
