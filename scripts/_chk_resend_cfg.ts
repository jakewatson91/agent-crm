import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import type { WorkspacePolicy } from '@agent-crm/tools';

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const wss = await sb.from('workspaces').select('id, name, policy');
  for (const ws of wss.data ?? []) {
    const p = (ws.policy ?? {}) as WorkspacePolicy;
    console.log(`${ws.name} (${(ws.id as string).slice(0, 8)}):`);
    console.log(`  outreach.from_email: ${p.outreach?.from_email ?? '(unset -> onboarding@resend.dev)'}`);
    console.log(`  outreach.override_to: ${p.outreach?.override_to ?? '(unset)'}`);
    console.log(`  policy.env.RESEND_API_KEY: ${p.env?.RESEND_API_KEY ? 'set (workspace-scoped)' : '(unset -> process.env)'}`);
    console.log(`  legacy outreach.resend_api_key: ${p.outreach?.resend_api_key ? 'set' : '(unset)'}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
