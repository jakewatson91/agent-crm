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
      tier?: 'hot' | 'default' | 'cold';
      angle_count?: number;
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
};

export const inngest = new Inngest({
  id: 'agent-crm',
  schemas: new EventSchemas().fromRecord<Events>(),
});
