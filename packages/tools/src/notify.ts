/**
 * Operator alert emails — "the system needs a human to look at something."
 *
 * Not the outreach sender (apps/web/app/api/_lib/send_email.ts): outreach mail
 * goes to prospects and obeys policy.outreach.override_to rerouting for
 * dogfooding. Alerts go to the workspace owner and must never be rerouted, so
 * this module posts to Resend directly with the same key resolution.
 *
 * Best-effort by design: every path returns a result instead of throwing, so a
 * failed alert can never break the pipeline write or cron it piggybacks on.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getPolicy, type PipelineStatus } from './policy.ts';

const RESEND_URL = 'https://api.resend.com/emails';

export interface AlertResult {
  ok: boolean;
  to?: string;
  /** Why nothing went out (no members on the workspace, no Resend key). */
  skipped?: string;
  error?: string;
}

/**
 * The workspace owner's login email: workspace_members role='owner', falling
 * back to the earliest member when no row carries the owner role. Needs a
 * service-role client (auth.admin is service-role only).
 */
export async function resolveOwnerEmail(sb: SupabaseClient, workspace_id: string): Promise<string | null> {
  const m = await sb
    .from('workspace_members')
    .select('user_id, role, created_at')
    .eq('workspace_id', workspace_id)
    .order('created_at', { ascending: true });
  const rows = (m.data ?? []) as Array<{ user_id: string; role: string }>;
  const owner = rows.find((r) => r.role === 'owner') ?? rows[0];
  if (!owner) return null;
  const u = await sb.auth.admin.getUserById(owner.user_id);
  return u.data?.user?.email ?? null;
}

/**
 * One plain-text alert to the workspace owner. Key resolution matches the
 * outreach sender (policy.env.RESEND_API_KEY → legacy outreach field →
 * process.env) so any workspace that can send outreach can send alerts.
 */
export async function sendOwnerAlert(sb: SupabaseClient, workspace_id: string, subject: string, body: string): Promise<AlertResult> {
  try {
    const policy = await getPolicy(sb, workspace_id);
    const apiKey = policy.env?.RESEND_API_KEY ?? policy.outreach?.resend_api_key ?? process.env.RESEND_API_KEY;
    if (!apiKey) return { ok: false, skipped: 'no Resend API key (workspace env or RESEND_API_KEY)' };
    const to = policy.alerts?.email ?? (await resolveOwnerEmail(sb, workspace_id));
    if (!to) return { ok: false, skipped: 'no alert recipient (policy.alerts.email unset, workspace has no members)' };
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: policy.outreach?.from_email ?? 'onboarding@resend.dev',
        to,
        subject,
        text: body,
      }),
    });
    if (!res.ok) return { ok: false, to, error: `resend ${res.status}: ${(await res.text()).slice(0, 300)}` };
    return { ok: true, to };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Email for the not-paused → paused transition. The body reuses status.reason,
 * the same sentence the amber banner shows, so the email and the UI never
 * disagree about what happened or what to do next.
 */
export async function notifyPipelinePaused(sb: SupabaseClient, workspace_id: string, status: PipelineStatus): Promise<AlertResult> {
  const ws = await sb.from('workspaces').select('name').eq('id', workspace_id).maybeSingle();
  const name = (ws.data?.name as string | undefined) ?? workspace_id.slice(0, 8);
  const scope = status.scope ?? 'all';
  const body = [
    `The "${name}" pipeline paused itself.`,
    '',
    status.reason ?? 'A provider returned an error.',
    '',
    `Scope: ${scope}${status.provider ? ` (provider: ${status.provider})` : ''}`,
    `Paused at: ${status.paused_at ?? new Date().toISOString()}`,
    '',
    'After fixing the cause, open the workspace and click Continue on the banner.',
    'You get one email per pause, not one per retry.',
  ].join('\n');
  return sendOwnerAlert(sb, workspace_id, `[agent-crm] ${name}: pipeline paused (${status.provider ?? scope})`, body);
}
