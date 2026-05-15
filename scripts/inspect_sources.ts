import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const r = await sb.from('sources')
    .select('*')
    .order('connector_type');
  if (r.error) { console.log('error:', r.error.message); return; }
  console.log(`found ${r.data?.length ?? 0} sources`);
  for (const s of (r.data ?? []) as Array<{ name: string; connector_type: string; active: boolean; schedule_cron: string | null; last_run_at: string | null; last_run_summary: any; params: any }>) {
    const sum = (s as any).last_run_summary ?? {};
    const cfg = (s as any).config ?? (s as any).params ?? {};
    console.log(`[${s.active ? 'ON ' : 'off'}] ${s.connector_type.padEnd(14)} ${s.name.padEnd(32)} cron=${s.schedule_cron ?? '-'}`);
    console.log(`     last=${s.last_run_at?.slice(5, 16) ?? 'never'} sig=${sum.signals_created ?? 0} ent=${sum.entities_created ?? 0} cfg=${JSON.stringify(cfg).slice(0, 140)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
