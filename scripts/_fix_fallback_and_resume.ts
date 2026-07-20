import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function main(){
  const ws=((await sb.from('workspaces').select('id, policy')).data??[]).find((w:any)=>(w.id as string).startsWith('af602fa1'))!;
  const p:any = { ...(ws.policy ?? {}) };
  p.enrichment = { ...(p.enrichment ?? {}) };
  const before = p.enrichment.contact_provider_fallback;
  p.enrichment.contact_provider_fallback = 'none';   // drop dead Hunter fallback
  delete p.pipeline;                                  // clear the stale Hunter pause
  const { error } = await sb.from('workspaces').update({ policy: p }).eq('id', ws.id);
  if (error) throw error;
  console.log('fallback', before, '->', p.enrichment.contact_provider_fallback, '| pause cleared');
}
main().catch(e=>{console.error(e);process.exit(1);});
