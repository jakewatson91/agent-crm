/**
 * Live test for the twice-daily health alert: run the cron's inner function
 * twice back to back. Run 1 should email each workspace with REDs; run 2
 * should send nothing (fingerprints unchanged).
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { runHealthAlerts } from '../inngest/functions/health_sweep.js';

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  console.log('=== run 1 (expect emails for RED workspaces) ===');
  console.log(JSON.stringify(await runHealthAlerts(sb), null, 2));
  console.log('=== run 2 (expect everything unchanged, no emails) ===');
  console.log(JSON.stringify(await runHealthAlerts(sb), null, 2));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
