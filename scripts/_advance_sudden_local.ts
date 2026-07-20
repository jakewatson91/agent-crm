/**
 * Run the advance pass for Sudden LOCALLY with live per-account logging, so we
 * can see the decisions tally instead of waiting on the Inngest dashboard.
 * Same caps the 14:30 UTC cron would use (policy.enrichment overrides, else
 * defaults). Run AFTER account + contact score backfills.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { advanceAccounts } from '../inngest/functions/advance_accounts.js';

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const { data: w } = await sb.from('workspaces').select('policy').eq('id', WS).single();
  const enr = (w?.policy as { enrichment?: { max_contact_pulls_per_run?: number; max_drafts_per_run?: number } } | null)?.enrichment;
  const res = await advanceAccounts(sb, {
    workspace_id: WS,
    contactCap: enr?.max_contact_pulls_per_run ?? 8,
    draftCap: enr?.max_drafts_per_run ?? 12,
    onEvent: (line) => console.log(line),
  });
  console.log('\nresult:', JSON.stringify(res, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
