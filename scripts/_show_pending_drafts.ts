import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data: wss } = await sb.from('workspaces').select('id');
  const sudden = wss!.find(w => w.id.startsWith('e7052848'))!;

  const { data: gates } = await sb.from('gates').select('id, requested_at, channel_post_id')
    .eq('workspace_id', sudden.id).is('decided_at', null).order('requested_at', { ascending: true });

  for (const g of gates ?? []) {
    const { data: post } = await sb.from('channel_posts').select('*').eq('id', g.channel_post_id).single();
    if (!post) { console.log(`gate ${g.id}: post missing`); continue; }

    console.log('════════════════════════════════════════════════════════');
    console.log(`REQUESTED: ${String(g.requested_at).slice(0, 16)}Z   post=${String(post.id).slice(0, 8)}`);
    console.log('---BODY---');
    console.log(String(post.body ?? ''));
    console.log(`---CITES (${(post.cites ?? []).length})---`);

    for (const factId of (post.cites ?? []) as string[]) {
      const { data: f } = await sb.from('facts').select('*').eq('id', factId).single();
      if (!f) { console.log(`  fact ${factId.slice(0, 8)}: MISSING`); continue; }
      const { data: ent } = await sb.from('entities').select('name').eq('id', f.subject_entity).single();
      let src = '';
      if (f.signal_id) {
        const { data: sig } = await sb.from('signals').select('structured_tags, content, summary').eq('id', f.signal_id).maybeSingle();
        const tags = (sig?.structured_tags ?? {}) as Record<string, unknown>;
        src = String(tags.url ?? tags.source_url ?? tags.job_url ?? tags.kind ?? '');
      }
      console.log(`  [${(ent?.name ?? '?')}] ${f.predicate} = ${String(f.object_text).slice(0, 120)}`);
      console.log(`      confidence=${f.confidence}  observed=${String(f.observed_at).slice(0, 10)}  ${src ? 'source: ' + src.slice(0, 100) : 'source: (no signal link)'}`);
    }
    console.log('');
  }
}

main().catch(console.error);
