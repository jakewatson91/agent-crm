/**
 * Empirical "does it run itself" test. Makes ats_hiring_main due again (sets
 * last_run_at back 25h) and polls until the PROD Inngest dispatcher picks it up
 * on its next hourly tick and source-run updates last_run_at — with no manual
 * run from us. Proves the scheduled path end-to-end.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const ws = 'af602fa1-1e0b-4bee-9841-01894553e0a9';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { data: src } = await sb.from('sources').select('id,name,last_run_at').eq('workspace_id', ws).eq('name', 'ats_hiring_main').single();
  if (!src) { console.error('ats_hiring_main not found'); process.exit(1); }
  const backdated = new Date(Date.now() - 25 * 3600_000).toISOString();
  await sb.from('sources').update({ last_run_at: backdated }).eq('id', src.id);
  console.log(`set ats_hiring_main.last_run_at -> ${backdated} (25h ago, now DUE)`);
  console.log(`watching for prod dispatcher to run it... (polls every 2m, up to 75m)`);

  const marker = Date.parse(backdated);
  const deadline = Date.now() + 75 * 60_000;
  while (Date.now() < deadline) {
    await sleep(120_000);
    const { data: now } = await sb.from('sources').select('last_run_at,last_run_status,last_run_summary').eq('id', src.id).single();
    const lr = now?.last_run_at ? Date.parse(now.last_run_at) : 0;
    const stamp = new Date().toISOString();
    if (lr > marker) {
      console.log(`\n✅ AUTO-RAN at ${now!.last_run_at} status=${now!.last_run_status}`);
      console.log(`   summary: ${JSON.stringify(now!.last_run_summary)}`);
      console.log(`   => prod Inngest dispatcher fired ats with no manual run. It runs itself.`);
      process.exit(0);
    }
    console.log(`[${stamp}] still ${now?.last_run_at} (not yet picked up)`);
  }
  console.log(`\n❌ 75m elapsed, dispatcher did NOT run ats. The cron fires but is not dispatching it — deeper issue.`);
  process.exit(2);
})();
