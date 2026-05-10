import type { SupabaseClient } from '@supabase/supabase-js';

export interface ConnectorContext {
  supabase: SupabaseClient;
  workspace_id: string;
  source_id: string;        // for parent_event_id chaining when calling tools
  config: Record<string, unknown>;
  /** Highest signal already seen for this source — connectors use this to avoid re-emitting */
  last_run_at: string | null;
}

export interface ConnectorResult {
  signals_created: number;
  entities_created: number;
  skipped: number;          // hits found but skipped (no entity match, deduped, below threshold)
  errors: string[];
}

export type Connector = (ctx: ConnectorContext) => Promise<ConnectorResult>;

export interface ConnectorMeta {
  type: string;              // e.g. 'hn'
  label: string;             // e.g. 'Hacker News'
  description: string;
  /** 'tool': generic capability (HTTP, search, scrape) the user fills from scratch.
   *  'preset': specific source with hardcoded URL/params, one-click setup.
   *  Renders in different sections of the UI. Defaults to 'preset'. */
  category?: 'tool' | 'preset';
  /** The exact `signal_source` string this connector tags signals with. Agent filters
   *  must match this value to fire on signals from this connector. Surfaced to the
   *  meta-agent so it doesn't invent variant strings (yc_directory vs yc, etc.). */
  emits_signal_source: string;
  /** Default cron schedule */
  schedule_cron: string;
  /** JSON schema for the config UI to render the form */
  config_schema: {
    fields: Array<{
      name: string;
      label: string;
      kind: 'text' | 'textarea' | 'number' | 'entity_picker_multi' | 'string_array';
      required?: boolean;
      help?: string;
      default?: unknown;
    }>;
  };
}
