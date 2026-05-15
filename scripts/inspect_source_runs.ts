/**
 * Dig into the last few runs of each source to see what's failing or what
 * the connector returned. Reads last_run_summary + the recent source.run events
 * for richer error context than the sources row holds.
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

  const srcRes = await sb.from('sources')
    .select('id, name, connector_type, active, last_run_at, last_run_status, last_run_summary')
    .in('connector_type', ['exa', 'web', 'hn'])
    .order('connector_type, name');
  for (const s of (srcRes.data ?? []) as any[]) {
    const sum = s.last_run_summary ?? {};
    console.log(`\n[${s.active ? 'ON ' : 'off'}] ${s.connector_type}/${s.name} (${s.id.slice(0, 8)})`);
    console.log(`  last_run=${s.last_run_at?.slice(5, 16) ?? 'never'} status=${s.last_run_status ?? '-'}`);
    console.log(`  signals=${sum.signals_created ?? 0} entities=${sum.entities_created ?? 0} skipped=${sum.skipped ?? 0}`);
    const errs = (sum.errors as string[] | undefined) ?? [];
    if (errs.length) {
      console.log(`  errors (${errs.length}):`);
      for (const e of errs.slice(0, 3)) console.log(`    - ${e.slice(0, 200)}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
