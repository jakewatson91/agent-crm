/**
 * Qualification runner — the autonomous entry point for the deep account
 * qualification loop (packages/agents/qualify.ts).
 *
 * Fired by agent_logic.ts when the action selector lands on `deep_research` for
 * an account whose fit already clears policy.qualification.min_icp. The cheap
 * fixed-fan-out research path (researchRunner) still handles medium-fit accounts;
 * this multi-step loop is reserved for the few accounts worth a human-grade look,
 * so its cost stays bounded.
 *
 * Same shape as researchRunner: one step, concurrency-limited per workspace.
 */
import { createServerClient } from '@agent-crm/db';
import { runQualification } from '@agent-crm/agents';
import { inngest } from '../client.js';

export interface QualificationRequest {
  workspace_id: string;
  entity_id: string;
  entity_name?: string;
  reason?: string;
}

export const qualificationRunner = inngest.createFunction(
  {
    id: 'qualification-runner',
    concurrency: { limit: 2, key: 'event.data.workspace_id' },
  },
  { event: 'qualification.requested' },
  async ({ event, step }) =>
    step.run('qualify-account', async () => {
      const { workspace_id, entity_id } = event.data as QualificationRequest;
      return runQualification(createServerClient(), { workspace_id, entity_id });
    }),
);
