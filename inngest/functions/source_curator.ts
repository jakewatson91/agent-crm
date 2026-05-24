/**
 * Source curator — daily Inngest cron that reads L1 per-source metrics and
 * autonomously mutates dead/weak sources (deactivate, rewrite query, add a
 * wider subscription). Every mutation is undo-able via the agent_actions
 * endpoints; the curator does NOT pre-ask for approval (see
 * `project-decide-and-notify` rule).
 *
 * Not a registered agent. A scheduled job that calls existing tools.
 */
import { createServerClient } from '@agent-crm/db';
import { curateWorkspaceSources } from '@agent-crm/tools';
import { inngest } from '../client.js';

export const sourceCurator = inngest.createFunction(
  { id: 'source-curator' },
  { cron: '0 8 * * *' },
  async ({ step }) => {
    return await step.run('curate-all-workspaces', async () => {
      const supabase = createServerClient();
      const wsRes = await supabase.from('workspaces').select('id, name');
      const workspaces = (wsRes.data ?? []) as Array<{ id: string; name: string }>;

      const perWorkspace: Array<{
        workspace_id: string;
        workspace_name: string;
        decisions: number;
        applied: number;
        skipped_cooldown: number;
        error?: string;
      }> = [];

      for (const ws of workspaces) {
        try {
          const r = await curateWorkspaceSources(supabase, ws.id, { apply: true });
          perWorkspace.push({
            workspace_id: ws.id,
            workspace_name: ws.name,
            decisions: r.decisions.length,
            applied: r.applied,
            skipped_cooldown: r.skipped_cooldown.length,
          });
        } catch (e) {
          perWorkspace.push({
            workspace_id: ws.id,
            workspace_name: ws.name,
            decisions: 0,
            applied: 0,
            skipped_cooldown: 0,
            error: (e as Error).message,
          });
        }
      }
      return { workspaces: perWorkspace };
    });
  },
);
