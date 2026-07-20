import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

function perDay(rows: Array<{ created_at: string }>, days = 14): string {
  const buckets: Record<string, number> = {};
  const cut = Date.now() - days * 86400_000;
  for (const r of rows) { const t = Date.parse(r.created_at); if (t >= cut) { const d = r.created_at.slice(0, 10); buckets[d] = (buckets[d] ?? 0) + 1; } }
  return Object.entries(buckets).sort().map(([d, n]) => `${d.slice(5)}:${n}`).join('  ') || '(none in window)';
}

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = ((await sb.from('workspaces').select('id, name')).data ?? []).find((w) => (w.id as string).startsWith('af602fa1'))!.id as string;

  console.log('=== sources (af602fa1) ===');
  const srcs = (await sb.from('sources').select('*').eq('workspace_id', ws)).data ?? [];
  for (const s of srcs as any[]) {
    console.log(`  ${s.active ? '●' : '○'} ${(s.name ?? '').padEnd(28)} ${String(s.connector_type).padEnd(14)} last_run=${s.last_run_at ?? s.config?.last_run_at ?? '—'}`);
  }

  const sig = (await sb.from('signals').select('created_at, type').eq('workspace_id', ws).order('created_at', { ascending: false }).limit(5000)).data ?? [];
  const ent = (await sb.from('entities').select('created_at').eq('workspace_id', ws).order('created_at', { ascending: false }).limit(5000)).data ?? [];

  console.log(`\n=== signals: ${sig.length} total | most recent ${ (sig[0] as any)?.created_at ?? '—'} ===`);
  console.log('  per day (14d):', perDay(sig as any));
  const types: Record<string, number> = {};
  for (const s of (sig as any[]).slice(0, 1000)) types[s.type] = (types[s.type] ?? 0) + 1;
  console.log('  recent signal types:', Object.entries(types).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}:${v}`).join('  '));

  console.log(`\n=== entities: ${ent.length} total | most recent ${ (ent[0] as any)?.created_at ?? '—'} ===`);
  console.log('  per day (14d):', perDay(ent as any));
}
main().catch((e) => { console.error(e); process.exit(1); });
