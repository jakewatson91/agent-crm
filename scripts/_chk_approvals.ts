import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function main(){
  const ws=((await sb.from('workspaces').select('id')).data??[]).find((w:any)=>(w.id as string).startsWith('af602fa1'))!.id as string;
  const { count } = await sb.from('gates').select('id',{count:'exact',head:true}).eq('workspace_id',ws).is('decision',null);
  console.log('pending approvals (gates, decision=null):', count);
}
main().catch(e=>{console.error(e);process.exit(1);});
