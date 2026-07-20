import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

async function main() {
  const since24 = new Date(Date.now() - 24 * 3600e3).toISOString();
  // Events by the icp_rescorer actor, last 24h, grouped by workspace + target
  const PAGE = 1000;
  const rows: Array<{ workspace_id: string; target_id: string | null; created_at: string; action: string }> = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from('events')
      .select('workspace_id, target_id, created_at, action')
      .eq('actor_id', 'icp_rescorer')
      .gte('created_at', since24)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if ((data ?? []).length < PAGE) break;
  }
  console.log(`icp_rescorer events last 24h: ${rows.length}`);
  const byWs = new Map<string, number>();
  const byTarget = new Map<string, number>();
  for (const r of rows) {
    byWs.set(r.workspace_id.slice(0, 8), (byWs.get(r.workspace_id.slice(0, 8)) ?? 0) + 1);
    const k = `${r.workspace_id.slice(0, 8)}:${r.target_id}`;
    byTarget.set(k, (byTarget.get(k) ?? 0) + 1);
  }
  console.log('by workspace:', Object.fromEntries(byWs));
  const repeats = [...byTarget.entries()].filter(([, n]) => n > 8).sort((a, b) => b[1] - a[1]);
  console.log(`targets hit >8 times in 24h: ${repeats.length}`);
  for (const [k, n] of repeats.slice(0, 10)) console.log(`  ${k}: ${n}`);

  // Distinct entities touched vs total events → repeat factor
  console.log(`distinct targets: ${byTarget.size}`);

  // icp_fit observed_at distribution for Sudden vs workspace updated_at
  const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
  const { data: ws } = await sb.from('workspaces').select('updated_at').eq('id', WS).single();
  console.log(`\nSudden workspaces.updated_at: ${ws?.updated_at}`);
  const { count: staleCount } = await sb.from('facts')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', WS).eq('predicate', 'icp_fit')
    .is('supersedes', null)
    .lt('observed_at', ws!.updated_at as string);
  console.log(`Sudden icp_fit facts with observed_at < updated_at (perpetually "stale"): ${staleCount}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
