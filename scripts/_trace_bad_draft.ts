import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function main(){
  const { data: post } = await sb.from('channel_posts').select('*').ilike('body', 'I know your platform was built by African%').maybeSingle();
  if (!post) { console.log('not found'); return; }
  console.log('post id:', post.id, 'channel_id:', post.channel_id, 'entity:', post.entity_id ?? '(none on row)');
  console.log('cites:', post.cites);
  const cites = (post.cites ?? []) as string[];
  const facts = (await sb.from('facts').select('*').in('id', cites)).data ?? [];
  for (const f of facts) {
    const { data: ent } = await sb.from('entities').select('name, kind').eq('id', f.subject_entity).maybeSingle();
    console.log('────');
    console.log(`entity: ${ent?.name} (${ent?.kind})`);
    console.log(`predicate: ${f.predicate}`);
    console.log(`object_text: ${f.object_text}`);
    console.log(`confidence: ${f.confidence}  observed_at: ${f.observed_at}  signal_id: ${f.signal_id}`);
    if (f.signal_id) {
      const { data: sig } = await sb.from('signals').select('*').eq('id', f.signal_id).maybeSingle();
      console.log('signal content:', String(sig?.content ?? sig?.summary ?? '').slice(0, 500));
      console.log('signal tags:', JSON.stringify(sig?.structured_tags ?? {}));
    }
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
