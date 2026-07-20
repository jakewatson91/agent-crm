import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function main(){
  const ws=((await sb.from('workspaces').select('id')).data??[]).find(w=>(w.id as string).startsWith('af602fa1'))!.id as string;
  const g=(await sb.from('gates').select('channel_post_id, condition').eq('workspace_id',ws).is('decision',null).order('requested_at',{ascending:false}).limit(1).maybeSingle()).data;
  if(!g){console.log('no pending gate');return;}
  const post=(await sb.from('channel_posts').select('body, cites').eq('id',g.channel_post_id).maybeSingle()).data;
  console.log('=== DRAFT (Mastra) ===\n'+post?.body);
  const cites=(post?.cites ?? []) as string[];
  console.log(`\n=== grounded in ${cites.length} cited facts ===`);
  if(cites.length){ const f=(await sb.from('facts').select('predicate,object_text').in('id',cites)).data ?? []; for(const x of f) console.log(`  · ${x.predicate}: ${String(x.object_text).slice(0,90)}`); }
}
main().catch(e=>{console.error(e);process.exit(1);});
