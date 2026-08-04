/**
 * Manually run the research dispatcher for Sudden right now instead of
 * waiting for the 4-hourly cron. Same function /api/research/run-now calls;
 * this just skips the authed-HTTP hop and calls the exported core directly.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
import { runResearchDispatch } from '../inngest/functions/entity_research_dispatcher.ts';

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

async function main() {
  const supabase = createServerClient();
  const summary = await runResearchDispatch(supabase, { workspaceIds: [WS] });
  console.log(JSON.stringify(summary, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
