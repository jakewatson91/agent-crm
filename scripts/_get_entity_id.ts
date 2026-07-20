import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
async function main() {
  const sb = createServerClient();
  const { data, error } = await sb.from('entities').select('id, name')
    .eq('workspace_id', 'e7052848-2270-41ac-90b6-d9b75c87f6d3')
    .eq('name', 'Al Kass').limit(1);
  if (error) throw error;
  console.log(JSON.stringify(data));
}
main().catch((e) => { console.error(e); process.exit(1); });
