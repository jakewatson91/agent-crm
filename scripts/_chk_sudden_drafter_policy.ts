import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
import { getPolicy } from '@agent-crm/tools';
async function main() {
  const sb = createServerClient();
  const p = await getPolicy(sb, 'e7052848-2270-41ac-90b6-d9b75c87f6d3');
  console.log('=== drafter ===');
  console.log(JSON.stringify(p.drafter, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
