/**
 * One-shot: (C) cut all yc sources to quarterly schedule, (D) reactivate HN sources.
 * Idempotent - safe to re-run.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const QUARTERLY = '0 6 1 */3 *';  // 06:00 UTC on the 1st of every 3rd month

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  // C: YC -> quarterly
  const ycRes = await sb.from('sources')
    .update({ schedule_cron: QUARTERLY })
    .eq('connector_type', 'yc')
    .select('name, schedule_cron');
  if (ycRes.error) console.log('YC update error:', ycRes.error.message);
  else {
    console.log(`YC: updated ${ycRes.data?.length ?? 0} source(s) to ${QUARTERLY}`);
    for (const r of ycRes.data ?? []) console.log(`  ${(r as any).name} -> ${(r as any).schedule_cron}`);
  }

  // D: HN -> reactivate
  const hnRes = await sb.from('sources')
    .update({ active: true })
    .eq('connector_type', 'hn')
    .eq('active', false)
    .select('name, active, schedule_cron, last_run_at');
  if (hnRes.error) console.log('HN update error:', hnRes.error.message);
  else {
    console.log(`HN: reactivated ${hnRes.data?.length ?? 0} source(s)`);
    for (const r of hnRes.data ?? []) console.log(`  ${(r as any).name} cron=${(r as any).schedule_cron} last_run=${(r as any).last_run_at ?? 'never'}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
