import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function main(){
  const ws=((await sb.from('workspaces').select('id')).data??[]).find((w:any)=>(w.id as string).startsWith('af602fa1'))!.id as string;
  const gates=(await sb.from('gates').select('channel_post_id, condition, requested_at').eq('workspace_id',ws).is('decision',null).order('requested_at',{ascending:false})).data ?? [];
  console.log(`\n===== ${gates.length} PENDING APPROVALS (the inbox) =====`);
  for(const g of gates){
    const c=g.condition as any;
    const post=(await sb.from('channel_posts').select('body,cites').eq('id',g.channel_post_id).maybeSingle()).data;
    const nCites=((post?.cites??[]) as string[]).length;
    const subj=(c?.subject??'').slice(0,50);
    console.log(`\n• ${c?.entity_name??'?'}  →  ${c?.to_email??'(no email)'}   [${nCites} facts]`);
    console.log(`  Subject: ${subj}`);
    const firstLine=(post?.body??'').split('\n').filter((l:string)=>l&&!l.startsWith('To:')&&!l.startsWith('Subject:'))[0]??'';
    console.log(`  ${firstLine.slice(0,120)}`);
  }
  console.log(`\n===== SUMMARY: ${gates.length} approvals ready =====`);
}
main().catch(e=>{console.error(e);process.exit(1);});
