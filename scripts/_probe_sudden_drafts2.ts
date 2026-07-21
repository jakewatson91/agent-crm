import { config } from 'dotenv';
config({ path: '/Users/jakewatson/src/agent-crm/.env.local' });
import { createClient } from '@supabase/supabase-js';

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

  const { data: drafts, error: e2 } = await sb.from('channel_posts')
    .select('id, created_at, body, channels!inner(workspace_id)')
    .eq('channels.workspace_id', WS).eq('kind', 'touch_draft')
    .order('created_at', { ascending: false }).limit(10);
  if (e2) console.log('drafts err:', e2.message);
  console.log('touch_draft count returned:', (drafts ?? []).length);
  for (const p of drafts ?? []) {
    console.log('────────────────────────────────');
    console.log(`${String(p.created_at).slice(0, 16)}  post=${String(p.id).slice(0, 8)}`);
    console.log('BODY:', String(p.body).slice(0, 480));
    const { data: kidRows } = await sb.from('channel_posts').select('kind, body')
      .eq('parent_post_id', p.id);
    for (const k of kidRows ?? []) console.log(`  [${k.kind}] ${String(k.body).slice(0, 320)}`);
  }

  // drafter runs, wider net
  const { data: runs, error: e3 } = await sb.from('events').select('created_at, payload')
    .eq('workspace_id', WS).eq('action', 'agent_run_metrics')
    .eq('payload->>behavior', 'drafter')
    .order('created_at', { ascending: false }).limit(25);
  if (e3) console.log('runs err:', e3.message);
  console.log('\n=== DRAFTER RUNS (wide) ===');
  for (const r of runs ?? []) {
    console.log(`${String(r.created_at).slice(0, 16)}  model=${(r as any).payload.model}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
