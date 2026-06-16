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
  /** Does each run cost money (per-call API credits)?
   *  - 'metered': hits a paid API (Exa, Hunter). A run that finds nothing is
   *    wasted spend, so the yield monitor may auto-deactivate it after a quiet
   *    stretch to stop burning credits.
   *  - 'free' (default): no per-call cost (public job boards, free tokens,
   *    push webhooks). These are diff connectors over a fixed watchlist — a week
   *    with zero new items is the NORMAL idle state, not a dead query, so they
   *    must NEVER auto-deactivate. Killing one means it never runs again and
   *    silently stops feeding the workspace.
   *  Unspecified = 'free' (a source never silently kills itself unless it's
   *  explicitly a credit-burner). */
  cost?: 'free' | 'metered';
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
