import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
const SUDDEN = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
async function main() {
  const sb = createServerClient();
  const { data: one } = await sb.from('gates').select('*').eq('workspace_id', SUDDEN).limit(1);
  console.log('gates columns:', one?.[0] ? Object.keys(one[0]).join(', ') : 'no rows');
  const { count: pending } = await sb.from('gates').select('id', { count: 'exact', head: true }).eq('workspace_id', SUDDEN).is('decided_at', null);
  const { count: total } = await sb.from('gates').select('id', { count: 'exact', head: true }).eq('workspace_id', SUDDEN);
  console.log('gates: total =', total, 'pending =', pending);
  const { count: nchan } = await sb.from('channels').select('id', { count: 'exact', head: true }).eq('workspace_id', SUDDEN);
  console.log('channels total =', nchan);
  const { data: recent } = await sb.from('gates').select('id, decided_at, requested_at, channel_post_id').eq('workspace_id', SUDDEN).order('requested_at', { ascending: false }).limit(10);
  for (const g of recent ?? []) console.log(' ', JSON.stringify(g).slice(0, 160));
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
