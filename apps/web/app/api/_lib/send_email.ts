/**
 * Resend email send.
 *
 * SAFETY: while dog-fooding, every send is rerouted to `OUTREACH_OVERRIDE_TO`
 * (default `jaws.watson@gmail.com`). To actually send to the intended recipient,
 * explicitly set `OUTREACH_OVERRIDE_TO=` (empty) in env AND review the calling
 * code. The subject is prefixed with `[would-have-sent-to: …]` so the override
 * is visible in the receiving inbox.
 *
 * Returns `{ ok, message_id?, error? }`. Never throws.
 */
const RESEND_URL = 'https://api.resend.com/emails';
const DEFAULT_OVERRIDE_TO = 'jaws.watson@gmail.com';
const DEFAULT_FROM = 'onboarding@resend.dev';   // no domain verification needed

export interface SendEmailArgs {
  intended_to: string | null;        // who the agent thinks the email is for
  subject: string;
  body: string;
}

export interface SendEmailResult {
  ok: boolean;
  message_id?: string;
  effective_to: string;              // where the email actually went
  override_active: boolean;
  error?: string;
}

export async function sendEmail({ intended_to, subject, body }: SendEmailArgs): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { ok: false, effective_to: '', override_active: false, error: 'RESEND_API_KEY not set' };
  }
  const overrideRaw = process.env.OUTREACH_OVERRIDE_TO;
  // If the env var is undefined, override is on. If it's set to empty string,
  // override is OFF (explicit opt-out). If it's set to anything else, use that.
  const override_active = overrideRaw !== '';
  const effective_to = override_active ? (overrideRaw && overrideRaw.length > 0 ? overrideRaw : DEFAULT_OVERRIDE_TO) : (intended_to ?? '');
  if (!effective_to) {
    return { ok: false, effective_to: '', override_active, error: 'no effective recipient (intended_to empty and override disabled)' };
  }

  const finalSubject = override_active
    ? `[would-have-sent-to: ${intended_to ?? 'no contact resolved'}] ${subject}`
    : subject;

  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM ?? DEFAULT_FROM,
        to: effective_to,
        subject: finalSubject,
        text: body,
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
