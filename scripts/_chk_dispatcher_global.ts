import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

async function main() {
  const since = new Date(Date.now() - 7 * 86400e3).toISOString();
  // research_triggered markers across ALL workspaces, last 7d, grouped by day+workspace
  const { data } = await sb.from('events')
    .select('workspace_id, type, created_at')
    .in('type', ['research_triggered', 'research_completed', 'research_error'])
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(3000);
  const byDayWs = new Map<string, number>();
  for (const e of data ?? []) {
    const k = `${e.created_at.slice(0, 10)} ${e.workspace_id.slice(0, 8)} ${e.type}`;
    byDayWs.set(k, (byDayWs.get(k) ?? 0) + 1);
  }
  console.log('=== research events by day × workspace × type (7d, all workspaces) ===');
  for (const [k, n] of [...byDayWs.entries()].sort().reverse()) console.log(`  ${k}: ${n}`);
  if (!byDayWs.size) console.log('  NONE — dispatcher has not fired for any workspace in 7 days');

  // Any inngest-driven events at all recently? (proves host+inngest alive)
  const { data: anyEv } = await sb.from('events')
    .select('workspace_id, type, created_at')
    .gte('created_at', new Date(Date.now() - 48 * 3600e3).toISOString())
    .order('created_at', { ascending: false })
    .limit(30);
  console.log('\n=== last 30 events, any type, any workspace (48h) ===');
  for (const e of anyEv ?? []) console.log(`  ${e.created_at}  ${e.workspace_id.slice(0, 8)}  ${e.type}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
