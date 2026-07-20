/**
 * Fire a source.run event for Sudden's ATS source through Inngest, then poll
 * until it completes. Confirms the connector works on real Sudden accounts
 * without waiting for tomorrow's 13:00 UTC cron tick.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { inngest } from '../inngest/client.js';

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const ws = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { data: src } = await db.from('sources').select('id,last_run_at,last_run_status').eq('workspace_id', ws).eq('connector_type', 'ats').single();
  if (!src) { console.error('ats source not found'); process.exit(1); }
  const before = src.last_run_at as string | null;
  console.log(`ats source_id=${src.id}  last_run_at(before)=${before}  status=${src.last_run_status}`);

  await inngest.send({ name: 'source.run', data: { source_id: src.id as string, workspace_id: ws } });
  console.log('sent source.run event -> Inngest will invoke prod source-run. polling...');

  for (let i = 0; i < 40; i++) {
    await sleep(15_000);
    const { data: now } = await db.from('sources').select('last_run_at,last_run_status,last_run_summary').eq('id', src.id).single();
    if (now && now.last_run_at !== before) {
      console.log(`\n✅ ats run completed at ${now.last_run_at}  status=${now.last_run_status}`);
      console.log(`   summary: ${JSON.stringify(now.last_run_summary)}`);
      process.exit(now.last_run_status === 'ok' ? 0 : 2);
    }
    console.log(`[${new Date().toISOString()}] still ${now?.last_run_at} (waiting)`);
  }
  console.log('\n⏱ no update after 10m — first run probes up to 500 job boards, may just be slow. Check again with pnpm status.');
  process.exit(3);
})();
