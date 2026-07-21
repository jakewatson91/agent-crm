/** One-shot verify: run the advance pass with draftCap=1 so exactly one new
 * draft goes through the fixed template path. */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { advanceAccounts } from '../inngest/functions/advance_accounts.js';

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const res = await advanceAccounts(sb, {
    workspace_id: WS,
    contactCap: 0,
    draftCap: 1,
    onEvent: (line) => console.log(line),
  });
  console.log('\nresult:', JSON.stringify(res, null, 2));

  const { data: drafts } = await sb.from('channel_posts')
    .select('id, created_at, body, channels!inner(workspace_id)')
    .eq('channels.workspace_id', WS).eq('kind', 'touch_draft')
    .order('created_at', { ascending: false }).limit(1);
  const p = (drafts ?? [])[0];
  if (!p) { console.log('no draft found'); return; }
  console.log('\n=== NEWEST DRAFT ===');
  console.log(`${String(p.created_at).slice(0, 16)}  post=${String(p.id).slice(0, 8)}`);
  console.log('BODY:', String(p.body));
  const { data: kids } = await sb.from('channel_posts').select('kind, body').eq('parent_post_id', p.id);
  for (const k of kids ?? []) console.log(`  [${k.kind}] ${String(k.body).slice(0, 400)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
