import { Inngest, EventSchemas } from 'inngest';

export type Events = {
  'signal.created': {
    data: {
      signal_id: string;
      workspace_id: string;
      entity_id: string;
      type: string;
      observed_at: string;
    };
  };
  'subscription.matched': {
    data: {
      subscription_id: string;
      signal_id?: string;       // present for signal-triggered matches
      fact_id?: string;         // present for fact-triggered matches
      workspace_id: string;
      owner_kind: 'agent' | 'user';
      owner_id: string;
      action_on_match: string;
      similarity?: number;      // signal-triggered only
    };
  };
  'fact.created': {
    data: {
      fact_id: string;
      workspace_id: string;
      subject_entity: string;
      predicate: string;
      object_text: string | null;
      confidence: number;
    };
  };
  'gate.created': {
    data: {
      gate_id: string;
      workspace_id: string;
      requested_by_agent: string;
      policy: string;
    };
  };
  'agent.run': {
    data: {
      workspace_id: string;
      agent: string;            // agent name
      trigger_event: 'subscription.matched' | 'manual';
      subscription_id?: string;
      signal_id?: string;
      fact_id?: string;
      // The entity this run is about. Drives the per-entity concurrency key on
      // agentRun (limit 1) so a burst of signals about the SAME account enriches
      // one-at-a-time instead of racing — which is what let the coalescer and
      // cooldown guards be skipped and produced duplicate facts + feed posts.
      entity_id?: string;
      parent_event_id?: string;
    };
  };
  'source.run': {
    data: {
      source_id: string;
      workspace_id: string;
    };
  };
  // Action-selector (reactive) or the entity-research dispatcher (proactive) emits
  // this when an entity merits a deep web pull. The runner executes the workspace's
  // AI-planned research strategy (angles) scoped to the entity, running `angle_count`
  // of them (set by the dispatcher's per-tier budget; default = all).
  'research.requested': {
    data: {
      workspace_id: string;
      entity_id: string;
      entity_name: string;
      reason: string;
      tier?: 'hot' | 'default' | 'cold' | 'contact';
      angle_count?: number;
      // 'contact': entity_id names a person, not a company. Default 'account'.
      kind?: 'account' | 'contact';
    };
  };
  // Action-selector emits this when an account fits but lacks a strong enough
  // contact to email (two-tier scoring). Triggers a contact-provider pull
  // scoped to the account's domain, then scores the new contacts.
  'contacts.requested': {
    data: {
      workspace_id: string;
      entity_id: string;
      entity_name: string;
      reason: string;
    };
  };
  // Action-selector emits this for a HIGH-fit account (icp_total >= the
  // workspace's qualification.min_icp) when deep_research fires. Runs the
  // adaptive multi-step qualification loop (packages/agents/qualify.ts) instead
  // of the fixed Exa fan-out. Reserved for accounts worth the extra cost.
  'qualification.requested': {
    data: {
      workspace_id: string;
      entity_id: string;
      entity_name?: string;
      reason?: string;
    };
  };
  // On-demand kick of the daily advance pass (same function the 14:30 UTC cron
  // runs). Sent by verification scripts or a future "run now" control. The pass
  // walks every workspace; data is informational only.
  'advance.requested': {
    data: {
      reason?: string;
    };
  };
  // On-demand kick of the daily digest email (same function the 15:15 UTC cron
  // runs). dailyDigestCron has always listened for this alongside its cron, but
  // the event was never declared here, so the trigger was a type error and
  // `pnpm -r typecheck` failed on it. Runtime was fine — Inngest does not
  // validate against this record — but a sender had no typed contract to write
  // against.
  'digest.requested': {
    data: {
      reason?: string;
      workspace_id?: string;
    };
  };
};

export const inngest = new Inngest({
  id: 'agent-crm',
  schemas: new EventSchemas().fromRecord<Events>(),
});
