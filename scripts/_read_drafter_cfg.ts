import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const w = ((await sb.from('workspaces').select('id, constitution, policy').limit(50)).data ?? []).find((x:any)=> String(x.id).startsWith('af602fa1')) as any;
  console.log('CONSTITUTION:', JSON.stringify(w.constitution ?? '(none)').slice(0,500));
  console.log('\nDRAFTER POLICY:', JSON.stringify(w.policy?.drafter ?? {}, null, 1).slice(0,1200));
  console.log('\ndrafter_model:', w.policy?.llm?.drafter_model ?? w.policy?.drafter_model ?? '(default)');
}
main().catch((e)=>{console.error(e.message);});
