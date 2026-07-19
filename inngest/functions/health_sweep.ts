/**
 * Twice-daily health alert cron — the session-start sweep, minus the session.
 *
 * Runs the same sweepWorkspace checks the SessionStart hook prints, and emails
 * the workspace owner ONLY when something is RED. Healthy days send nothing.
 *
 * Dedupe: the sorted RED check ids are fingerprinted into a health_alert event
 * marker. A rerun with the identical RED set sends nothing, so a standing
 * condition (an intentional manual pause, a known scorer issue) alerts once
 * instead of nagging twice a day forever. When the set changes — a new RED
 * appears, or one clears while others remain — the full current list goes out
 * again. A fully-cleared set writes an empty fingerprint so a later recurrence
 * of the same RED re-alerts.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { createServerClient } from '@agent-crm/db';
import { sweepWorkspace, sendOwnerAlert, type CheckResult } from '@agent-crm/tools';
import { inngest } from '../client.js';

const MARKER_ACTION = 'health_alert';

function alertBody(name: string, reds: CheckResult[]): string {
  const lines = [`The health sweep found problems in "${name}":`, ''];
  for (const c of reds) {
    lines.push(`RED [${c.id}] ${c.metric}${c.threshold ? ` (threshold ${c.threshold})` : ''}`);
    if (c.action) lines.push(`  fix: ${c.action}`);
    lines.push('');
  }
  lines.push('You get this email when the RED set changes, not on every run.');
  return lines.join('\n');
}

export async function runHealthAlerts(sb: SupabaseClient): Promise<Record<string, unknown>> {
  const wss = await sb.from('workspaces').select('id, name');
  // Throw, don't continue: a dead DB must fail the whole step so the cloud
  // heartbeat is NOT pinged (a completed-but-empty sweep would ping green
  // with the database down).
  if (wss.error) throw new Error(`workspaces query failed: ${wss.error.message}`);
  const out: Record<string, unknown> = {};
  for (const ws of (wss.data ?? []) as Array<{ id: string; name: string }>) {
    try {
      const checks = await sweepWorkspace(sb, ws.id);
      const reds = checks.filter((c) => c.severity === 'red');
      const fingerprint = reds.map((c) => c.id).sort().join(',');
      const last = await sb
        .from('events')
        .select('payload')
        .eq('workspace_id', ws.id)
        .eq('action', MARKER_ACTION)
        .eq('target_kind', 'workspace')
        .eq('target_id', ws.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      const lastFingerprint = ((last.data?.payload as { fingerprint?: string } | null)?.fingerprint) ?? '';
      if (fingerprint === lastFingerprint) {
        out[ws.id] = { reds: reds.length, sent: false, why: 'unchanged since last alert' };
        continue;
      }
      await sb.from('events').insert({
        workspace_id: ws.id,
        actor_kind: 'system',
        actor_id: 'health_sweep',
        action: MARKER_ACTION,
        target_kind: 'workspace',
        target_id: ws.id,
        payload: { fingerprint, red_ids: reds.map((c) => c.id) },
      });
      if (reds.length === 0) {
        out[ws.id] = { reds: 0, sent: false, why: 'cleared' };
        continue;
      }
      const subject = `${ws.name}: ${reds.length} RED health check${reds.length === 1 ? '' : 's'}`;
      const sent = await sendOwnerAlert(sb, ws.id, subject, alertBody(ws.name, reds));
      out[ws.id] = { reds: reds.length, sent: sent.ok, to: sent.to, problem: sent.error ?? sent.skipped };
    } catch (e) {
      out[ws.id] = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  return out;
}

// Cloud heartbeat. This cron is the aliveness proxy for the whole primary
// scheduler: a ping only fires after a completed sweep, so silence means
// Render, Inngest, or the DB is down (or this function itself is failing).
// Separate check + env var from the laptop loop's HEALTHCHECKS_PING_URL —
// same name in both runtimes would let cloud pings mask a dead backstop.
async function pingCloudHeartbeat(): Promise<Record<string, unknown>> {
  const url = process.env.HEALTHCHECKS_PING_URL_CLOUD;
  if (!url) return { pinged: false, why: 'HEALTHCHECKS_PING_URL_CLOUD unset' };
  try {
    const res = await fetch(url);
    return { pinged: res.ok, status: res.status };
  } catch (e) {
    return { pinged: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export const healthSweepCron = inngest.createFunction(
  { id: 'health-sweep', concurrency: { limit: 1 } },
  { cron: '15 11,23 * * *' },
  async ({ step }) =>
    step.run('sweep-and-alert', async () => {
      const results = await runHealthAlerts(createServerClient());
      const heartbeat = await pingCloudHeartbeat();
      return { ...results, heartbeat };
    }),
);
