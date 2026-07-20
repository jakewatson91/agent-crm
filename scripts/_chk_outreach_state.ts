import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function main() {
  const { data: dog } = await sb.from('workspaces').select('policy').eq('id', 'af602fa1-1e0b-4bee-9841-01894553e0a9').single();
  const { data: sud } = await sb.from('workspaces').select('policy').eq('id', 'e7052848-2270-41ac-90b6-d9b75c87f6d3').single();
  console.log('dogfood outreach:', JSON.stringify((dog!.policy as Record<string, unknown>).outreach));
  console.log('sudden outreach:', JSON.stringify((sud!.policy as Record<string, unknown>).outreach));
  console.log('sudden pipeline:', JSON.stringify((sud!.policy as Record<string, unknown>).pipeline));
}
main().catch((e) => { console.error(e); process.exit(1); });
