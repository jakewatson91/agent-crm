/**
 * Config write: set policy.alerts.email on every workspace so operator alerts
 * deliver while Resend runs in testing mode (only the Resend account's own
 * address is deliverable from onboarding@resend.dev).
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const ALERT_EMAIL = 'jakeawatson91@gmail.com';

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const wss = await sb.from('workspaces').select('id, name, policy');
  for (const ws of wss.data ?? []) {
    const raw = (ws.policy ?? {}) as Record<string, unknown>;
    const alerts = { ...((raw.alerts as Record<string, unknown>) ?? {}), email: ALERT_EMAIL };
    const { error } = await sb.from('workspaces').update({ policy: { ...raw, alerts } }).eq('id', ws.id);
    console.log(`${ws.name} (${(ws.id as string).slice(0, 8)}): alerts.email=${ALERT_EMAIL} ${error ? `ERROR ${error.message}` : 'ok'}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
