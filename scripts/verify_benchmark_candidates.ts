import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const CANDIDATES = ['11x.ai', 'Sendbird', 'Trigify.io', 'Ramp', 'Netic', 'Explorium', 'Knowlee', 'Ethos', 'Growth Talent', 'Salesforce'];

async function main() {
  const ws = await supabase.from('workspaces').select('id').like('name', 'demo · agent-crm%').order('created_at', { ascending: false }).limit(1).single();
  if (ws.error) throw ws.error;
  const wsId = ws.data.id as string;

  console.log('candidate                facts  contacts  signals  past_touch  attrs');
  console.log('---------                -----  --------  -------  ----------  -----');
  for (const name of CANDIDATES) {
    const ent = await supabase.from('entities').select('id, name, attributes').eq('workspace_id', wsId).eq('kind', 'account').eq('name', name).maybeSingle();
    if (!ent.data) { console.log(`${name.padEnd(24)} NOT FOUND`); continue; }
    const id = ent.data.id as string;
    const attrs = (ent.data.attributes ?? {}) as Record<string, unknown>;

    const facts = await supabase.from('facts').select('id', { count: 'exact', head: true }).eq('workspace_id', wsId).eq('subject_entity', id);
    const worksAt = await supabase.from('facts').select('id', { count: 'exact', head: true }).eq('workspace_id', wsId).eq('predicate', 'works_at').eq('object_entity', id);
    const sigs = await supabase.from('signals').select('id', { count: 'exact', head: true }).eq('workspace_id', wsId).eq('entity_id', id);

    const ch = await supabase.from('channels').select('id').eq('workspace_id', wsId).eq('account_entity_id', id).maybeSingle();
    let pt: any = null;
    if (ch.data?.id) {
      const posts = await supabase.from('channel_posts').select('id').eq('channel_id', ch.data.id).eq('kind', 'touch_draft').limit(1);
      pt = posts.data?.[0] ?? null;
    }
    const attrKeys = Object.keys(attrs).slice(0, 5).join(',');
    console.log(`${name.slice(0,24).padEnd(24)} ${String(facts.count ?? 0).padStart(5)}  ${String(worksAt.count ?? 0).padStart(8)}  ${String(sigs.count ?? 0).padStart(7)}  ${pt ? 'yes       ' : 'NO        '}  ${attrKeys}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
