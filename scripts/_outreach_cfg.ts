import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const w = ((await sb.from('workspaces').select('id, policy').limit(50)).data ?? []).find((x:any)=> String(x.id).startsWith('af602fa1')) as any;
  console.log('WS:', w.id);
  console.log('outreach:', JSON.stringify(w.policy?.outreach ?? {}, null, 1));
  console.log('value_themes:', JSON.stringify(w.policy?.drafter?.value_themes ?? '(none)'));
}
main().catch((e)=>{console.error(e.message);});
