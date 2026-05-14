/**
 * Read-only audit: print current sources + enricher subscription state.
 * Use to verify Step 1-3 of mellow-finding-noodle plan.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const ws = await sb
    .from('workspaces').select('id, name')
    .like('name', 'demo · agent-crm%')
    .order('created_at', { ascending: false }).limit(1).single();
  if (ws.error || !ws.data) throw new Error('no demo workspace');
  const WS = ws.data.id as string;
  console.log(`workspace: ${ws.data.name} (${WS.slice(0, 8)}…)\n`);

  console.log('=== SOURCES ===');
  const sources = await sb.from('sources')
    .select('id, name, connector_type, active, last_run_at, last_run_status, last_run_summary')
    .eq('workspace_id', WS)
    .order('connector_type');
  if (sources.error) throw sources.error;
  if (!sources.data?.length) {
    console.log('  (none)');
  } else {
    for (const s of sources.data) {
      const summary = s.last_run_summary as { signals_created?: number; entities_created?: number; errors?: string[] } | null;
      const sig = summary?.signals_created ?? 0;
      const ent = summary?.entities_created ?? 0;
      const err = summary?.errors?.length ?? 0;
      const last = s.last_run_at ? new Date(s.last_run_at as string).toISOString().slice(5, 16).replace('T', ' ') : 'never';
      console.log(`  [${s.active ? 'ON ' : 'off'}] ${s.connector_type.padEnd(12)} ${(s.name as string).padEnd(38)} last=${last} ${s.last_run_status ?? '-'} (sig=${sig} ent=${ent} err=${err})`);
    }
  }

  console.log('\n=== ENRICHER SUBSCRIPTIONS ===');
  const subs = await sb.from('subscriptions')
    .select('id, name, owner_id, structured_filter, threshold, active')
    .eq('workspace_id', WS)
    .ilike('owner_id', '%enricher%');
  if (subs.error) throw subs.error;
  if (!subs.data?.length) {
    console.log('  (none — no enricher subscriptions found)');
  } else {
    for (const s of subs.data) {
      console.log(`  [${s.active ? 'ON ' : 'off'}] ${(s.name as string).padEnd(40)} owner=${s.owner_id}`);
      console.log(`    filter: ${JSON.stringify(s.structured_filter)}`);
      console.log(`    threshold: ${s.threshold}`);
    }
  }

  console.log('\n=== ALL AGENTS ===');
  const agents = await sb.from('agents')
    .select('id, name, owner_id, agent_behavior, active')
    .eq('workspace_id', WS)
    .order('agent_behavior');
  if (!agents.error && agents.data) {
    for (const a of agents.data) {
      console.log(`  [${a.active ? 'ON ' : 'off'}] ${(a.agent_behavior ?? '?').padEnd(13)} ${(a.name as string).padEnd(40)} owner=${a.owner_id}`);
    }
  }

  console.log('\n=== RECENT SIGNAL VOLUME (last 7d) ===');
  // signal_source lives in structured_tags jsonb, not as a column.
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const sigs = await sb.from('signals')
    .select('type, structured_tags')
    .eq('workspace_id', WS)
    .gte('created_at', since)
    .limit(10000);
  if (sigs.error) {
    console.log(`  error: ${sigs.error.message}`);
  } else if (!sigs.data?.length) {
    console.log('  (no signals in last 7d)');
  } else {
    const byType = new Map<string, number>();
    for (const s of sigs.data as Array<{ type: string; structured_tags: { signal_source?: string } | null }>) {
      const src = s.structured_tags?.signal_source ?? '(null)';
      const k = `${src}/${s.type}`;
      byType.set(k, (byType.get(k) ?? 0) + 1);
    }
    for (const [k, v] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k.padEnd(40)} ${v}`);
    }
    console.log(`  total: ${sigs.data.length}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
