/**
 * Resend email send.
 *
 * Behavior is workspace-scoped: `workspaces.policy.outreach.override_to` reroutes
 * sends (used while dog-fooding so drafts land in a known inbox); leaving it
 * null sends to the real recipient. `from_email` and `resend_api_key` also live
 * on policy. RESEND_API_KEY env stays as a fallback so existing deployments
 * keep working before backfill.
 *
 * Returns `{ ok, message_id?, error? }`. Never throws.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getPolicy } from '@agent-crm/tools/policy';

const RESEND_URL = 'https://api.resend.com/emails';

export interface SendEmailArgs {
  supabase: SupabaseClient;
  workspace_id: string;
  intended_to: string | null;        // who the agent thinks the email is for
  subject: string;
  body: string;                      // plain-text body (always sent as the text part)
  html?: string;                     // optional sanitized HTML body (rich-text drafts)
}

export interface SendEmailResult {
  ok: boolean;
  message_id?: string;
  effective_to: string;              // where the email actually went
  override_active: boolean;
  error?: string;
}

export async function sendEmail({ supabase, workspace_id, intended_to, subject, body, html }: SendEmailArgs): Promise<SendEmailResult> {
  const policy = await getPolicy(supabase, workspace_id);
  // Resolution: policy.env.RESEND_API_KEY → legacy policy.outreach.resend_api_key → process.env.
  const apiKey = policy.env?.RESEND_API_KEY ?? policy.outreach?.resend_api_key ?? process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { ok: false, effective_to: '', override_active: false, error: 'no Resend API key (set on workspace env vars or RESEND_API_KEY env)' };
  }
  const override_to = policy.outreach?.override_to;
  const override_active = !!override_to;
  const effective_to = override_active ? override_to! : (intended_to ?? '');
  if (!effective_to) {
    return { ok: false, effective_to: '', override_active, error: 'no effective recipient (intended_to empty and no override configured)' };
  }

  // Override-rerouted copies land in the operator's inbox, so they carry the
  // [agent-crm] tag like every other system email. Real prospect sends keep
  // the drafted subject untouched — a platform tag on cold outreach kills it.
  const finalSubject = override_active
    ? `[agent-crm] [would-have-sent-to: ${intended_to ?? 'no contact resolved'}] ${subject}`
    : subject;

  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: policy.outreach?.from_email ?? 'onboarding@resend.dev',
        to: effective_to,
        subject: finalSubject,
        // Always include text (deliverability + text-only clients). When the
        // user formatted a rich draft, html is the primary part.
        text: body,
        ...(html ? { html } : {}),
      }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      return { ok: false, effective_to, override_active, error: `resend ${res.status}: ${errBody.slice(0, 300)}` };
    }
    const j = await res.json() as { id?: string };
    return { ok: true, message_id: j.id, effective_to, override_active };
  } catch (e) {
    return { ok: false, effective_to, override_active, error: e instanceof Error ? e.message : String(e) };
  }
}
