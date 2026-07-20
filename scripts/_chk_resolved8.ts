import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
async function main() {
  const sb = createServerClient();
  const names = ['TG4', 'RTVC Play', 'Chili', 'Disney NOW', 'Teleantioquia Play', 'CMGO', 'Pilot WP', 'Kocowa'];
  const { data } = await sb.from('entities').select('name, attributes')
    .eq('workspace_id', 'e7052848-2270-41ac-90b6-d9b75c87f6d3').in('name', names);
  for (const e of (data ?? []) as any[]) console.log(e.name, '→', e.attributes?.domain ?? '(no match)');
}
main().catch((e) => { console.error(e); process.exit(1); });
