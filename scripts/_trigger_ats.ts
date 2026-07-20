/**
 * Fire a source.run event for ats_hiring_main through Inngest (same event the
 * dispatcher emits), then poll until prod source-run updates the source row.
 * Confirms prod source-run works with the now-present DEEPSEEK_API_KEY, without
 * waiting for the hourly cron tick.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { inngest } from '../inngest/client.js';

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const ws = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { data: src } = await db.from('sources').select('id,last_run_at,last_run_status').eq('workspace_id', ws).eq('name', 'ats_hiring_main').single();
  if (!src) { console.error('ats not found'); process.exit(1); }
  const before = src.last_run_at as string;
  console.log(`ats source_id=${src.id}  last_run_at(before)=${before}  status=${src.last_run_status}`);

  await inngest.send({ name: 'source.run', data: { source_id: src.id as string, workspace_id: ws } });
  console.log('sent source.run event -> Inngest will invoke prod source-run. polling...');

  for (let i = 0; i < 30; i++) {
    await sleep(15_000);
    const { data: now } = await db.from('sources').select('last_run_at,last_run_status,last_run_summary').eq('id', src.id).single();
    if (now && now.last_run_at !== before) {
      console.log(`\n✅ prod source-run completed at ${now.last_run_at}  status=${now.last_run_status}`);
      console.log(`   summary: ${JSON.stringify(now.last_run_summary)}`);
      process.exit(now.last_run_status === 'ok' ? 0 : 2);
    }
    console.log(`[${new Date().toISOString()}] still ${now?.last_run_at} (waiting)`);
  }
  console.log('\n⏱ no update after ~7.5m — source-run still not completing');
  process.exit(3);
})();
