// Verify #1: a real Exa 402 on a single Sudden entity triggers the
// research-scope pause path inside runDomainBackfillBatch.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { runDomainBackfillBatch } from '../inngest/functions/system_tasks.ts';
import { createServerClient } from '@agent-crm/db';
import { getPipelineStatus } from '@agent-crm/tools';

const SUDDEN = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

async function main() {
  const sb = createServerClient();
  const r = await runDomainBackfillBatch(sb, [
    { workspace_id: SUDDEN, entity_id: process.argv[2]!, entity_name: process.argv[3]! },
  ]);
  console.log('batch result:', JSON.stringify(r));
  const pipe = await getPipelineStatus(sb, SUDDEN);
  console.log('pipeline after:', JSON.stringify(pipe)?.slice(0, 200));
}
main().catch((e) => { console.error(e); process.exit(1); });
