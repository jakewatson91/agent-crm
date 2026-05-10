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
      signal_id: string;
      workspace_id: string;
      owner_kind: 'agent' | 'user';
      owner_id: string;
      action_on_match: string;
      similarity: number;
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
      parent_event_id?: string;
    };
  };
  'source.run': {
    data: {
      source_id: string;
      workspace_id: string;
    };
  };
};

export const inngest = new Inngest({
  id: 'agent-crm',
  schemas: new EventSchemas().fromRecord<Events>(),
});
