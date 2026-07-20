// Live #1 verify post-topup: scan (Sudden now eligible) + resolve 8 for real.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { scanDomainBackfillCandidates, runDomainBackfillBatch } from '../inngest/functions/system_tasks.ts';
import { createServerClient } from '@agent-crm/db';

async function main() {
  const sb = createServerClient();
  const candidates = await scanDomainBackfillCandidates(sb);
  console.log('scan candidates:', candidates.length);
  const batch = candidates.slice(0, 8);
  console.log('resolving:', batch.map((b) => b.entity_name).join(', '));
  const r = await runDomainBackfillBatch(sb, batch);
  console.log('result:', JSON.stringify(r));
}
main().catch((e) => { console.error(e); process.exit(1); });
