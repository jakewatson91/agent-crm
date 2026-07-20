import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function main(){
  const ws=((await sb.from('workspaces').select('id, policy')).data??[]).find((w:any)=>(w.id as string).startsWith('af602fa1'))!;
  const p:any = ws.policy ?? {};
  console.log('contact_provider        :', p.enrichment?.contact_provider ?? '(unset)');
  console.log('contact_provider_fallback:', p.enrichment?.contact_provider_fallback ?? '(unset)');
  const envBag = p.env ?? {};
  console.log('EXPLORIUM_API_KEY in policy.env:', envBag.EXPLORIUM_API_KEY ? 'yes' : 'no', '| in process.env:', process.env.EXPLORIUM_API_KEY ? 'yes' : 'no');
  console.log('HUNTER_API_KEY   in policy.env:', envBag.HUNTER_API_KEY ? 'yes' : 'no', '| in process.env:', process.env.HUNTER_API_KEY ? 'yes' : 'no');
  console.log('pipeline status         :', JSON.stringify(p.pipeline ?? null));
}
main().catch(e=>{console.error(e);process.exit(1);});
