// Clear Sudden's research pause (same write as the Continue button).
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
import { getPipelineStatus, setPipelineStatus } from '@agent-crm/tools';

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

async function main() {
  const sb = createServerClient();
  const status = await getPipelineStatus(sb, WS);
  if (status?.state !== 'paused') { console.log('not paused:', JSON.stringify(status)?.slice(0, 120)); return; }
  const next = { state: 'ok' as const, last_run_at: status.last_run_at, last_run: status.last_run };
  await setPipelineStatus(sb, WS, next);
  console.log('cleared. now:', JSON.stringify(await getPipelineStatus(sb, WS))?.slice(0, 160));
}
main().catch((e) => { console.error(e); process.exit(1); });
