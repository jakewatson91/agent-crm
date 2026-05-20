/**
 * One-off: run the ATS connector against the demo workspace, bypassing Inngest.
 * Used after the verification step landed + the bogus-Sila cleanup to force
 * the 17 reset entities to re-probe with verification active.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import ats from '../inngest/functions/sources/connectors/ats.js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

(async () => {
  const SOURCE_ID = '8f72e1dd-8679-415e-9ae6-63de6a1b39c0';
  const WS_ID = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
  console.log('Running ATS connector with verification...');
  const t0 = Date.now();
  const result = await ats({
    supabase,
    workspace_id: WS_ID,
    source_id: SOURCE_ID,
    config: {},
    last_run_at: null,
  } as any);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n=== DONE in ${dt}s ===`);
  console.log({
    signals_created: result.signals_created,
    entities_created: result.entities_created,
    skipped: result.skipped,
    errors_count: result.errors.length,
  });
  console.log('\nLog messages:');
  for (const e of result.errors) console.log(' -', e);
  await supabase.from('sources').update({ last_run_at: new Date().toISOString(), last_run_status: result.errors.length ? 'error' : 'ok' }).eq('id', SOURCE_ID);
})();
