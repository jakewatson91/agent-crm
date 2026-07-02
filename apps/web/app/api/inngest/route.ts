import { serve } from 'inngest/next';

// Vercel: source runs + agent enrichment can take >10s. Pro plans allow 300; Hobby caps at 60.
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

// Defer loading the inngest client + every function module until the first request.
// In dev, this means routes you're iterating on don't pay the cost of compiling the
// ~5k LOC of background-job code unless `inngest dev` is actually polling this route.
type ServeReturn = ReturnType<typeof serve>;
let cached: Promise<ServeReturn> | null = null;

function getHandlers(): Promise<ServeReturn> {
  if (cached) return cached;
  cached = (async () => {
    const [{ inngest }, fns] = await Promise.all([
      import('@agent-crm/inngest'),
      import('@agent-crm/inngest/functions'),
    ]);
    return serve({
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
    });
  })();
  return cached;
}

export async function GET(...args: Parameters<ServeReturn['GET']>) {
  return (await getHandlers()).GET(...args);
}
export async function POST(...args: Parameters<ServeReturn['POST']>) {
  return (await getHandlers()).POST(...args);
}
export async function PUT(...args: Parameters<ServeReturn['PUT']>) {
  return (await getHandlers()).PUT(...args);
}
