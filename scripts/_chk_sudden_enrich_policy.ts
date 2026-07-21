import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
import { getPolicy } from '@agent-crm/tools';
async function main() {
  const sb = createServerClient();
  const p = await getPolicy(sb, 'e7052848-2270-41ac-90b6-d9b75c87f6d3');
  console.log('enrichment.example_facts:', JSON.stringify(p.enrichment?.example_facts, null, 2));
  console.log('enrichment.banned_predicates:', JSON.stringify(p.enrichment?.banned_predicates, null, 2));
  console.log('icp:', JSON.stringify(p.icp, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
