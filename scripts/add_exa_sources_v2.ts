/**
 * Adds three more Exa intent searches for ICP coverage. Idempotent: skips a source
 * if a row with the same name already exists in this workspace.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const NEW_SOURCES = [
  {
    name: 'exa_first_sales_hire_ai_startups',
    query: 'AI startup Series A founder hiring first AE BDR going from product-led to outbound',
    keywords: ['first hire', 'AE', 'BDR', 'sales', 'founder-led', 'AI startup', 'Series A'],
  },
  {
    name: 'exa_revops_scaling_outbound',
    query: 'RevOps director scaling outbound team B2B SaaS hiring playbooks tooling',
    keywords: ['RevOps', 'outbound', 'B2B SaaS', 'scaling', 'director', 'tooling'],
  },
  {
    name: 'exa_crm_switch_ai_workflow',
    query: 'companies switching off Salesforce HubSpot frustrated with AI workflow integration',
    keywords: ['switching CRM', 'Salesforce', 'HubSpot', 'frustrated', 'AI workflow', 'replace'],
  },
];

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const ws = await sb.from('workspaces').select('id, name')
    .like('name', 'demo · agent-crm%')
    .order('created_at', { ascending: false }).limit(1).single();
  if (ws.error || !ws.data) throw new Error('no demo workspace');
  const WS = ws.data.id as string;
  console.log(`workspace: ${ws.data.name}\n`);

  const existing = await sb.from('sources').select('name').eq('workspace_id', WS);
  const existingNames = new Set<string>((existing.data ?? []).map((r) => r.name as string));

  for (const s of NEW_SOURCES) {
    if (existingNames.has(s.name)) {
      console.log(`  [skip] ${s.name} already exists`);
      continue;
    }
    const insert = await sb.from('sources').insert({
      workspace_id: WS,
      connector_type: 'exa',
      name: s.name,
      config: {
        query: s.query,
        intent: 'discover',
        watch_entities: [],
        include_domains: [],
        exclude_domains: [],
        roles: [],
        keywords: s.keywords,
        num_results: 25,
        since_hours: 168,
        search_type: 'auto',
      },
      schedule_cron: '0 */6 * * *',
      active: true,
    }).select('id').single();
    if (insert.error) {
      console.log(`  [err]  ${s.name}: ${insert.error.message}`);
    } else {
      console.log(`  [add]  ${s.name} → ${insert.data?.id?.slice(0, 8)}…`);
    }
  }
  console.log('\ndone.');
}
main().catch((e) => { console.error(e); process.exit(1); });
