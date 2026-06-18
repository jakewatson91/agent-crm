/**
 * One-shot pipeline status — "is everything running, and show me real signals."
 *
 *   pnpm status                     # full overview
 *   pnpm status <signal_type>       # dump 20 most recent signals of that type (full body + tags)
 *   pnpm status <signal_type> 50    # ...N most recent
 *   WORKSPACE_ID=<uuid> pnpm status
 *
 * Reads prod Supabase via .env.local (service role). Pure read-only.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const ws = process.env.WORKSPACE_ID ?? 'af602fa1-1e0b-4bee-9841-01894553e0a9';
const arg = process.argv[2];
const argN = parseInt(process.argv[3] ?? '20', 10);

const hAgo = (ts: string | null | undefined) =>
  ts ? `${((Date.now() - Date.parse(ts)) / 3600000).toFixed(1)}h` : 'never';

// Map entity_ids → names in one query.
async function names(ids: string[]): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return new Map();
  const { data } = await db.from('entities').select('id, name').in('id', uniq.slice(0, 200));
  return new Map((data ?? []).map((e: { id: string; name: string }) => [e.id, e.name]));
}

// ── DRILL-DOWN: dump recent signals of one type ───────────────────────────────
async function dumpSignals(type: string, n: number) {
  const { data } = await db
    .from('signals')
    .select('entity_id, magnitude, body_for_embedding, structured_tags, observed_at, created_at')
    .eq('workspace_id', ws)
    .eq('type', type)
    .order('created_at', { ascending: false })
    .limit(n);
  const rows = data ?? [];
  if (!rows.length) { console.log(`no "${type}" signals in this workspace.`); return; }
  const nm = await names(rows.map((r) => r.entity_id as string));
  console.log(`\n=== ${rows.length} most recent "${type}" signals ===\n`);
  for (const r of rows) {
    const tags = (r.structured_tags ?? {}) as Record<string, unknown>;
    const src = tags.signal_source ?? tags.source_id ?? '?';
    const url = tags.url ?? tags.item_url ?? tags.source_url ?? '';
    console.log(`• ${hAgo(r.created_at as string)} ago  ${nm.get(r.entity_id as string) ?? r.entity_id}  (mag ${r.magnitude}, src ${src})`);
    if (url) console.log(`    ${url}`);
    console.log(`    ${String(r.body_for_embedding ?? '').replace(/\s+/g, ' ').slice(0, 200)}`);
  }
}

// ── OVERVIEW ──────────────────────────────────────────────────────────────────
async function overview() {
  console.log(`workspace: ${ws}\n`);

  // 1. Active sources
  console.log('── SOURCES (active) ──');
  const { data: sources } = await db
    .from('sources')
    .select('name, connector_type, last_run_at, last_run_status, last_run_summary')
    .eq('workspace_id', ws).eq('active', true)
    .order('last_run_at', { ascending: false, nullsFirst: false });
  if (!sources?.length) console.log('  (none active)');
  for (const s of sources ?? []) {
    const sum = s.last_run_summary as { signals_created?: number; signals_7d?: number; skipped?: number } | null;
    console.log(`  ${s.name} (${s.connector_type})  ran ${hAgo(s.last_run_at as string)} ago [${s.last_run_status}]  created=${sum?.signals_created ?? '?'} 7d=${sum?.signals_7d ?? '?'} skipped=${sum?.skipped ?? '?'}`);
  }

  // 2. Signals — recent sample, by type
  const { count: sigTotal } = await db.from('signals').select('id', { count: 'exact', head: true }).eq('workspace_id', ws);
  const { data: sample } = await db
    .from('signals')
    .select('type, entity_id, body_for_embedding, structured_tags, created_at')
    .eq('workspace_id', ws)
    .order('created_at', { ascending: false })
    .limit(3000);
  const rows = sample ?? [];
  const dayAgo = Date.now() - 86400000;
  const byType = new Map<string, { total: number; d1: number; last: string }>();
  for (const r of rows) {
    const t = r.type as string;
    const e = byType.get(t) ?? { total: 0, d1: 0, last: r.created_at as string };
    e.total++;
    if (Date.parse(r.created_at as string) >= dayAgo) e.d1++;
    byType.set(t, e);
  }
  console.log(`\n── SIGNALS  (${sigTotal ?? 0} total; breakdown of the ${rows.length} most recent) ──`);
  for (const [t, e] of [...byType.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${t.padEnd(18)} ${String(e.total).padStart(5)}  | last 24h: ${e.d1}  | newest ${hAgo(e.last)} ago`);
  }

  // 3. Most recent real signals
  console.log('\n── 8 MOST RECENT SIGNALS ──');
  const recent = rows.slice(0, 8);
  const nm = await names(recent.map((r) => r.entity_id as string));
  for (const r of recent) {
    console.log(`  ${hAgo(r.created_at as string)} ago  [${r.type}]  ${nm.get(r.entity_id as string) ?? r.entity_id}`);
    console.log(`     ${String(r.body_for_embedding ?? '').replace(/\s+/g, ' ').slice(0, 140)}`);
  }

  // 4. Pipeline output (channel_posts via channels join)
  const { data: posts } = await db
    .from('channel_posts')
    .select('kind, created_at, channels!inner(workspace_id)')
    .eq('channels.workspace_id', ws)
    .order('created_at', { ascending: false })
    .limit(2000);
  const prows = (posts ?? []) as Array<{ kind: string; created_at: string }>;
  const wkAgo = Date.now() - 7 * 86400000;
  const byKind = new Map<string, { d1: number; d7: number }>();
  for (const p of prows) {
    const e = byKind.get(p.kind) ?? { d1: 0, d7: 0 };
    const t = Date.parse(p.created_at);
    if (t >= dayAgo) e.d1++;
    if (t >= wkAgo) e.d7++;
    byKind.set(p.kind, e);
  }
  console.log(`\n── PIPELINE OUTPUT (channel_posts; newest ${hAgo(prows[0]?.created_at)} ago) ──`);
  for (const [k, e] of [...byKind.entries()].sort((a, b) => b[1].d7 - a[1].d7)) {
    console.log(`  ${k.padEnd(14)} 24h: ${String(e.d1).padStart(4)}   7d: ${e.d7}`);
  }

  // 5. Enrichment loop markers
  console.log('\n── ENRICHMENT (research loop) ──');
  for (const pred of ['research_triggered', 'research_completed', 'research_error']) {
    const { count } = await db.from('facts').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).eq('predicate', pred);
    console.log(`  ${pred.padEnd(20)} ${count ?? 0}`);
  }
  const { count: rr } = await db.from('signals').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).eq('type', 'research_result');
  console.log(`  research_result sigs  ${rr ?? 0}`);

  // 6. Pending approvals
  const { count: pending } = await db.from('gates').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).is('decided_at', null);
  console.log(`\n── GATES ──\n  pending approvals: ${pending ?? 0}`);

  console.log('\ntip: `pnpm status <signal_type>` to dump recent signals of one type (e.g. hiring_post, research_result).');
}

(async () => {
  if (arg) await dumpSignals(arg, argN);
  else await overview();
})();
