import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const since72h = new Date(Date.now() - 72 * 3600e3).toISOString();

async function countEvents(type: string) {
  const { count } = await sb.from('events').select('id', { count: 'exact', head: true })
    .eq('workspace_id', WS).eq('action', type).gte('created_at', since72h);
  return count ?? 0;
}

async function main() {
  const types = [
    'research_triggered', 'research_completed', 'research_error',
    'agent_dispatch_result', 'agent_run_metrics', 'subscription.matched',
    'create_signal', 'assert_fact',
  ];
  console.log('=== Sudden events, last 72h ===');
  for (const t of types) console.log(`  ${t}: ${await countEvents(t)}`);

  // Recent research events with timestamps to see the cadence
  const { data: recent } = await sb.from('events')
    .select('action, created_at, payload')
    .eq('workspace_id', WS)
    .in('action', ['research_triggered', 'research_completed', 'research_error'])
    .gte('created_at', since72h)
    .order('created_at', { ascending: false })
    .limit(12);
  console.log('\n=== recent research events ===');
  for (const e of recent ?? []) {
    const p = e.payload as Record<string, unknown> | null;
    console.log(`  ${e.created_at}  ${e.action}  ${JSON.stringify(p)?.slice(0, 140)}`);
  }

  // Signals created recently (research results land as signals)
  const { data: sigs } = await sb.from('signals')
    .select('id, created_at, structured_tags')
    .eq('workspace_id', WS)
    .gte('created_at', since72h)
    .order('created_at', { ascending: false })
    .limit(10);
  console.log('\n=== signals last 72h ===', sigs?.length ?? 0);
  for (const s of sigs ?? []) {
    console.log(`  ${s.created_at}  tags=${JSON.stringify(s.structured_tags)?.slice(0, 120)}`);
  }

  // Facts asserted recently (non-score)
  const { data: facts } = await sb.from('facts')
    .select('predicate, observed_at')
    .eq('workspace_id', WS)
    .gte('observed_at', since72h)
    .order('observed_at', { ascending: false })
    .limit(2000);
  const byPred = new Map<string, number>();
  for (const f of facts ?? []) byPred.set(f.predicate, (byPred.get(f.predicate) ?? 0) + 1);
  console.log('\n=== facts asserted last 72h by predicate ===');
  for (const [p, n] of [...byPred.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${p}: ${n}`);

  // Domain coverage
  const PAGE = 1000;
  let withDomain = 0, total = 0;
  for (let from = 0; ; from += PAGE) {
    const { data } = await sb.from('entities').select('id, attributes').eq('workspace_id', WS).range(from, from + PAGE - 1);
    const page = data ?? [];
    total += page.length;
    for (const e of page) {
      const d = (e.attributes as Record<string, unknown> | null)?.domain;
      if (typeof d === 'string' && d.length > 0) withDomain++;
    }
    if (page.length < PAGE) break;
  }
  console.log(`\n=== domain coverage: ${withDomain}/${total} entities have attributes.domain ===`);

  // Pending approvals (drafts waiting)
  const { count: pendingGates } = await sb.from('gates').select('id', { count: 'exact', head: true })
    .eq('workspace_id', WS).is('decided_at', null);
  console.log(`\npending gates (approvals): ${pendingGates}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
