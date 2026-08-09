/**
 * Daily digest email — everything the platform did in the last 24h, delivered
 * to the workspace owner's inbox. This is how a single operator keeps track of
 * their outreach without opening the app: score moves joined to the signals
 * that drove them, drafts written, approvals waiting, spend estimate.
 *
 * Opt-in per workspace via policy.report.daily_email (default off). Recipient
 * and Resend-key resolution are sendOwnerAlert's (policy.alerts.email → owner
 * login email). Content is the exact same period digest `pnpm report` prints,
 * so the email and the CLI can never disagree.
 *
 * 15:15 UTC sits after the 14:30 advance pass, so the digest includes today's
 * drafts and the approvals they opened. The digest.requested event trigger
 * lets a run be kicked on demand without waiting for the cron.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { createServerClient } from '@agent-crm/db';
import { getPolicy, resolvePeriod, collectPeriod, renderMarkdown, mdToHtml, sendOwnerAlert } from '@agent-crm/tools';
import { inngest } from '../client.ts';

export async function runDailyDigests(sb: SupabaseClient): Promise<Record<string, unknown>> {
  const wss = await sb.from('workspaces').select('id, name');
  if (wss.error) throw new Error(`workspaces query failed: ${wss.error.message}`);
  const out: Record<string, unknown> = {};
  for (const ws of (wss.data ?? []) as Array<{ id: string; name: string }>) {
    try {
      const policy = await getPolicy(sb, ws.id);
      if (policy.report?.daily_email !== true) {
        out[ws.id] = { sent: false, why: 'daily_email off' };
        continue;
      }
      const window = resolvePeriod({ hours: 24 });
      const data = await collectPeriod(sb, ws.id, ws.name, window);
      const md = renderMarkdown(data);
      // Subject leads with what needs the human, then what the agent did.
      const waiting = data.approvals.pending.length;
      const drafted = data.posts.filter((p) => p.kind === 'touch_draft').length;
      const subject = `${ws.name} daily: ${waiting} awaiting approval, ${drafted} drafted, ${data.moves.length} accounts moved`;
      const sent = await sendOwnerAlert(sb, ws.id, subject, md, mdToHtml(md));
      out[ws.id] = { sent: sent.ok, to: sent.to, problem: sent.error ?? sent.skipped };
    } catch (e) {
      out[ws.id] = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  return out;
}

export const dailyDigestCron = inngest.createFunction(
  { id: 'daily-digest', concurrency: { limit: 1 } },
  [{ cron: '15 15 * * *' }, { event: 'digest.requested' }],
  async ({ step }) =>
    step.run('collect-and-send', async () => runDailyDigests(createServerClient())),
);
