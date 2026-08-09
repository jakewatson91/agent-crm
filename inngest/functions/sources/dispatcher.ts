import { createServerClient } from '@agent-crm/db';
import { cronToMinIntervalMinutes, getPipelineStatus } from '@agent-crm/tools';
import { inngest } from '../../client.ts';
import { getConnector } from './registry.ts';

/**
 * source-dispatcher: hourly tick that fans out a `source.run` event for each
 * active source whose own `schedule_cron` is due relative to its `last_run_at`.
 * Honoring per-source schedule matters because before this enforcement, every
 * 6-hour Exa source ran every hour — paying for 6× the queries the connector
 * author specified. Same problem for daily YC + ProductHunt.
 */
export type DueSourceRow = { id: string; workspace_id: string; connector_type: string; last_run_at: string | null };

// A workspace paused with scope 'all' means "spend nothing on metered APIs":
// sources that hit a paid API themselves (Exa) or that reliably fan out to
// enrichers burning LLM tokens should stop. Narrower scopes (research,
// contacts) don't block ingestion. A manual `source.run` event still bypasses
// this — an explicit operator kick is deliberate.
//
// Free connectors (ats, hn, yc, github, producthunt, webhooks, ...) are
// exempt: they cost nothing to run, and CSV import / inbound webhooks already
// ingest signals through this exact pause with no gate at all (see
// packages/tools/src/ingest.ts) — a downstream agent run that can't reach the
// LLM records `agent_llm_failed` and skips instead of erroring, the same as
// any other LLM outage. Blanket-skipping free sources bought nothing but
// silence: this is what stalled ats_hiring_main for the entire length of the
// 2026-08-01 DeepSeek credit wall, mirroring the auto-deactivate bug in
// sourceRun below that the same isMetered split already fixed once.
export function selectDueSources(rows: DueSourceRow[], pausedAll: Set<string>, now: number) {
  const out: Array<{ id: string; workspace_id: string }> = [];
  let skipped = 0;
  for (const s of rows) {
    const conn = getConnector(s.connector_type);
    if (!conn) continue;
    if (conn.meta.cost === 'metered' && pausedAll.has(s.workspace_id)) { skipped++; continue; }
    const intervalMin = cronToMinIntervalMinutes(conn.meta.schedule_cron);
    if (s.last_run_at) {
      const ageMin = (now - Date.parse(s.last_run_at)) / 60000;
      // 10% slack so we don't miss a tick when both crons fire close together.
      if (ageMin < intervalMin * 0.9) { skipped++; continue; }
    }
    out.push({ id: s.id, workspace_id: s.workspace_id });
  }
  return { due: out, skipped };
}

export const sourceDispatcher = inngest.createFunction(
  { id: 'source-dispatcher' },
  { cron: '0 * * * *' },
  async ({ step }) => {
    const due = await step.run('select-due-sources', async () => {
      const supabase = createServerClient();
      const { data, error } = await supabase
        .from('sources')
        .select('id, workspace_id, connector_type, last_run_at')
        .eq('active', true);
      if (error) throw error;

      const rows = (data ?? []) as DueSourceRow[];
      const pausedAll = new Set<string>();
      for (const wsId of new Set(rows.map((r) => r.workspace_id))) {
        const status = await getPipelineStatus(supabase, wsId);
        if (status?.state === 'paused' && (status.scope ?? 'all') === 'all') pausedAll.add(wsId);
      }

      return selectDueSources(rows, pausedAll, Date.now());
    });

    if (!due.due.length) return { dispatched: 0, skipped: due.skipped };

    await step.sendEvent('fan-out-sources', due.due.map((s) => ({
      name: 'source.run' as const,
      data: { source_id: s.id, workspace_id: s.workspace_id },
    })));

    return { dispatched: due.due.length, skipped: due.skipped };
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

      // Yield tracking: how many signals has this source produced over the
      // last 7d? Used to detect dead queries and silently auto-deactivate so
      // we stop burning Exa/Hunter/etc credits on sources that find nothing.
      // Source attribution lives in event.actor_id (e.g. `source:exa:1a2b3c4d`).
      const sourceActorPrefix = `source:${source.connector_type}:${(source.id as string).slice(0, 8)}`;
      const since7d = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
      const { count: signals7d } = await supabase
        .from('events')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', source.workspace_id as string)
        .eq('action', 'create_signal')
        .eq('actor_id', sourceActorPrefix)
        .gte('created_at', since7d);

      const summary: Record<string, unknown> = {
        signals_created: out.signals_created,
        entities_created: out.entities_created,
        skipped: out.skipped,
        errors: out.errors.slice(0, 5),
        signals_7d: signals7d ?? 0,
      };

      // Auto-deactivate dead sources: zero yield in 7d AND the source has
      // existed long enough for that to be meaningful. The created_at check
      // protects brand-new sources from getting killed before their first
      // signal lands.
      //
      // ONLY for metered (paid-API) connectors — the whole point is to stop
      // burning Exa/Hunter credits on a query that finds nothing. Free diff
      // connectors (ats, hn, github, ...) watch a fixed list of companies; a
      // week with no new job post / event is their normal idle state, not a
      // dead query. Auto-killing one is permanent: the dispatcher only ticks
      // active sources, so a deactivated free source never runs again and the
      // workspace silently stops getting fed. That death spiral is exactly
      // what stalled ats_hiring_main.
      const isMetered = connector.meta.cost === 'metered';
      const { data: srcMeta } = await supabase
        .from('sources').select('created_at').eq('id', source.id).single();
      const createdAt = srcMeta?.created_at ? new Date(srcMeta.created_at as string) : null;
      const olderThan7d = createdAt && (Date.now() - createdAt.getTime()) > 7 * 86400 * 1000;
      const shouldDeactivate = isMetered && (signals7d ?? 0) === 0 && olderThan7d;

      const update: Record<string, unknown> = {
        last_run_at: new Date().toISOString(),
        last_run_status: status,
        last_run_summary: summary,
      };
      if (shouldDeactivate) update.active = false;
      await supabase.from('sources').update(update).eq('id', source.id);

      if (shouldDeactivate) {
        await supabase.from('events').insert({
          workspace_id: source.workspace_id as string,
          actor_kind: 'system',
          actor_id: 'source_yield_monitor',
          action: 'source_deactivated',
          target_kind: 'workspace',
          target_id: source.workspace_id as string,
          payload: {
            source_id: source.id,
            connector_type: source.connector_type,
            reason: 'zero_signals_7d',
            signals_7d: 0,
          },
        });
      }

      return { ok: status === 'ok', summary: { ...out, signals_7d: signals7d, deactivated: shouldDeactivate } };
    });

    return result;
  },
);
