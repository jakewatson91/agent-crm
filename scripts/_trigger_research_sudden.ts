/**
 * Manually run the research dispatcher for Sudden right now instead of
 * waiting for the 4-hourly cron. Same function /api/research/run-now calls;
 * this just skips the authed-HTTP hop and calls the exported core directly.
 *
 * The dispatcher's dispatch step calls inngest.send(), and the Inngest client
 * reads INNGEST_EVENT_KEY once at construction. Static imports are hoisted
 * above any other top-level code in the file, so a static import of anything
 * that pulls in inngest/client.ts would construct that client — and freeze
 * whatever key was already in the process environment — before config()
 * below ever runs. Dynamic imports run in place instead, so config() goes
 * first here on purpose.
 */
import { config } from 'dotenv';
config({ path: '.env.local', override: true });
import { createServerClient } from '@agent-crm/db';

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

async function main() {
  // Relative path, not a workspace alias, so the dynamic import below resolves
  // without needing tsx's path-mapping hook (which only patches static imports).
  const { runResearchDispatch } = await import('../inngest/functions/entity_research_dispatcher.ts');
  const supabase = createServerClient();
  const summary = await runResearchDispatch(supabase, { workspaceIds: [WS] });
  console.log(JSON.stringify(summary, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
