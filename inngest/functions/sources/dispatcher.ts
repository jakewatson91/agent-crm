import { createServerClient } from '@agent-crm/db';
import { inngest } from '../../client.js';
import { getConnector } from './registry.js';

/**
 * source-dispatcher: hourly cron that fans out a `source.run` event for each
 * active source whose `last_run_at` indicates it's due. For v0 we run every
 * active source on every tick (simple). Per-source schedule_cron is stored
 * but not yet enforced — that's a v1 refinement.
 */
export const sourceDispatcher = inngest.createFunction(
  { id: 'source-dispatcher' },
  { cron: '0 * * * *' },
  async ({ step }) => {
    const sources = await step.run('fetch-active-sources', async () => {
      const supabase = createServerClient();
      const { data, error } = await supabase
        .from('sources')
        .select('id, workspace_id, connector_type')
        .eq('active', true);
      if (error) throw error;
      return data ?? [];
    });

    if (!sources.length) return { dispatched: 0 };

    await step.sendEvent('fan-out-sources', sources.map((s: any) => ({
      name: 'source.run' as const,
      data: { source_id: s.id as string, workspace_id: s.workspace_id as string },
    })));

    return { dispatched: sources.length };
  },
);

/**
 * source-run: executes one connector for one source. Idempotent on retry.
 * Updates last_run_at + last_run_status + last_run_summary.
 */
export const sourceRun = inngest.createFunction(
  { id: 'source-run', concurrency: { limit: 5, key: 'event.data.workspace_id' } },
  { event: 'source.run' },
  async ({ event, step }) => {
    const result = await step.run('run-connector', async () => {
      const supabase = createServerClient();
      const { data: source, error } = await supabase
        .from('sources')
        .select('id, workspace_id, connector_type, config, last_run_at')
        .eq('id', event.data.source_id)
        .single();
      if (error || !source) throw new Error(`source ${event.data.source_id} not found: ${error?.message}`);

      const connector = getConnector(source.connector_type as string);
      if (!connector) {
        return { ok: false, summary: { error: `unknown connector_type: ${source.connector_type}`, signals_created: 0, entities_created: 0, skipped: 0 } };
      }

      const out = await connector.run({
        supabase,
        workspace_id: source.workspace_id as string,
        source_id: source.id as string,
        config: (source.config ?? {}) as Record<string, unknown>,
        last_run_at: (source.last_run_at as string | null) ?? null,
      });

      const status = out.errors.length === 0 ? 'ok' : 'error';
      await supabase
        .from('sources')
        .update({
          last_run_at: new Date().toISOString(),
          last_run_status: status,
          last_run_summary: {
            signals_created: out.signals_created,
            entities_created: out.entities_created,
            skipped: out.skipped,
            errors: out.errors.slice(0, 5),  // cap to avoid jsonb bloat
          },
        })
        .eq('id', source.id);

      return { ok: status === 'ok', summary: out };
    });

    return result;
  },
);
