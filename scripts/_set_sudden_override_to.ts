import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
async function main() {
  const { data } = await sb.from('workspaces').select('policy').eq('id', WS).single();
  const policy = data!.policy as Record<string, any>;
  policy.outreach = { ...(policy.outreach ?? {}), override_to: 'agentcrm91@gmail.com' };
  const { error } = await sb.from('workspaces').update({ policy }).eq('id', WS);
  if (error) throw new Error(error.message);
  console.log('sudden outreach.override_to =', policy.outreach.override_to);
}
main().catch((e) => { console.error(e); process.exit(1); });
