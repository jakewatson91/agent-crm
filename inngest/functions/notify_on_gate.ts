import { createServerClient } from '@agent-crm/db';
import { inngest } from '../client.ts';

/**
 * gate.created -> dispatch notification(s) per workspace policy.
 *
 * v0: in-app only (no email/webhook yet — wired week 3 once policy schema firms up).
 * The fact that the gate exists in the DB means the UI badge will increment via Realtime;
 * this function exists to be the seam for email/Slack/webhook fan-out when we add those.
 */
export const notifyOnGate = inngest.createFunction(
  { id: 'notify-on-gate' },
  { event: 'gate.created' },
  async ({ event, step }) => {
    const policy = await step.run('load-policy', async () => {
      const supabase = createServerClient();
      const { data } = await supabase.from('workspaces').select('policy').eq('id', event.data.workspace_id).maybeSingle();
      return (data?.policy ?? {}) as { notify_channels?: string[] };
    });

    const channels = policy.notify_channels ?? ['in_app'];
    return { gate_id: event.data.gate_id, dispatched_to: channels };
  },
);
