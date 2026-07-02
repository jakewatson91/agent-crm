/**
 * One-off Inngest app sync on behalf of the deployed Render app.
 *
 * Why: INNGEST_BASE_URL=https://inn.gs (the event-ingest host) makes the SDK's
 * register call 404 — inn.gs only accepts events. Execution is unaffected, but
 * PUT /api/inngest can never register new functions. This script registers the
 * SAME app id + function set with serveHost pointed at the Render URL, talking
 * to the real API host (api.inngest.com), so the new cron lands without a
 * dashboard click. Long-term fix: remove INNGEST_BASE_URL from Render env.
 */
import { config } from 'dotenv';
config({ path: '../.env.local' });

// Must be unset BEFORE importing inngest so the SDK falls back to its real
// API base for registration.
delete process.env.INNGEST_BASE_URL;

async function main() {
  const { serve } = await import('inngest/next');
  const { inngest } = await import('./client.ts');
  const fns = await import('./functions/index.ts');

  const handler = serve({
    client: inngest,
    functions: [
      fns.matchSignal,
      fns.matchFact,
      fns.onSubscriptionMatched,
      fns.agentRun,
      fns.notifyOnGate,
      fns.sourceDispatcher,
      fns.sourceRun,
      fns.recoverUnmatchedSignals,
      fns.rescoreOnIcpChange,
      fns.researchRunner,
      fns.qualificationRunner,
      fns.contactsRunner,
      fns.entityResearchDispatcher,
      fns.advanceAccountsCron,
      fns.silenceSweep,
      fns.entityArchiveSweep,
      fns.retentionSweep,
      fns.sourceCurator,
      fns.subscriptionDriftLearner,
    ],
    serveHost: 'https://agent-crm-fm1f.onrender.com',
    servePath: '/api/inngest',
    signingKey: process.env.INNGEST_SIGNING_KEY,
  });

  const req = new Request('https://agent-crm-fm1f.onrender.com/api/inngest', { method: 'PUT' });
  // @ts-expect-error next-style handler accepts a fetch Request
  const res = await handler.PUT(req);
  console.log('status:', res.status);
  console.log(await res.text());
}
main().catch((e) => { console.error(e); process.exit(1); });
