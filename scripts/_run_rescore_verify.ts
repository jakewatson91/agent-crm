// Verify #2: run the shipping scanRescoreCandidates; optionally run the batch
// with "apply" as argv[2].
import { config } from 'dotenv';
config({ path: '.env.local' });
import { scanRescoreCandidates, runRescoreBatch } from '../inngest/functions/system_tasks.ts';
import { createServerClient } from '@agent-crm/db';

async function main() {
  const sb = createServerClient();
  const candidates = await scanRescoreCandidates(sb);
  const byWs = new Map<string, number>();
  for (const c of candidates) byWs.set(c.workspace_id.slice(0, 8), (byWs.get(c.workspace_id.slice(0, 8)) ?? 0) + 1);
  console.log('candidates:', candidates.length, Object.fromEntries(byWs));
  console.log('sample:', candidates.slice(0, 5));
  if (process.argv[2] === 'apply' && candidates.length) {
    const r = await runRescoreBatch(sb, candidates);
    console.log('batch:', JSON.stringify(r));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
