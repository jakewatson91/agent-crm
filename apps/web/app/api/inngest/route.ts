import { serve } from 'inngest/next';
import { inngest } from '@agent-crm/inngest';
import {
  matchSignal,
  matchFact,
  onSubscriptionMatched,
  agentRun,
  notifyOnGate,
  sourceDispatcher,
  sourceRun,
  recoverUnmatchedSignals,
  systemHealthMonitor,
  rescoreOnIcpChange,
} from '@agent-crm/inngest/functions';

// Vercel: source runs + agent enrichment can take >10s. Pro plans allow 300; Hobby caps at 60.
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    matchSignal,
    matchFact,
    onSubscriptionMatched,
    agentRun,
    notifyOnGate,
    sourceDispatcher,
    sourceRun,
    recoverUnmatchedSignals,
    systemHealthMonitor,
    rescoreOnIcpChange,
  ],
});
