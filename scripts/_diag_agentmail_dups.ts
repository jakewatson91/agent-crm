import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

async function main() {
  // find AgentMail entity in the main workspace
  const { data: ents } = await sb.from('entities')
    .select('id, name, workspace_id')
    .ilike('name', '%agentmail%');
  console.log('AgentMail entities:', ents);
  if (!ents?.length) return;

  for (const e of ents) {
    const { data: ch } = await sb.from('channels').select('id, title').eq('account_entity_id', e.id);
    for (const c of ch ?? []) {
      const { data: posts } = await sb.from('channel_posts')
        .select('id, kind, body, cites, created_at, parent_post_id, author_kind')
        .eq('channel_id', c.id)
        .order('created_at', { ascending: false });
      console.log(`\n=== entity ${e.name} (${e.id.slice(0,8)}) channel ${c.title} (${c.id.slice(0,8)}) — ${posts?.length} posts ===`);
      // group by kind
      const byKind: Record<string, number> = {};
      for (const p of posts ?? []) byKind[p.kind] = (byKind[p.kind]||0)+1;
      console.log('by kind:', byKind);
      // show claim posts
      const claims = (posts ?? []).filter(p => p.kind === 'claim');
      console.log(`\n--- ${claims.length} claim posts (newest first) ---`);
      for (const p of claims.slice(0, 40)) {
        console.log(`${p.created_at}  cites=${JSON.stringify(p.cites)}  ${(p.body||'').slice(0,90).replace(/\n/g,' ')}`);
      }
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
