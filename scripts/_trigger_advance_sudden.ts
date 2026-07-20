/**
 * Fire advance.requested for Sudden so the daily contacts+drafts pass runs
 * now instead of waiting for the 14:30 UTC cron. Run AFTER rescore_all.ts
 * has given Sudden's accounts score_total facts, or this will scan 0 again.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { inngest } from '../inngest/client.js';

(async () => {
  await inngest.send({ name: 'advance.requested', data: {} });
  console.log('sent advance.requested — check WORKSPACE_ID=e7052848-2270-41ac-90b6-d9b75c87f6d3 pnpm status in ~1-2 min for updated policy.pipeline.last_run');
})();
