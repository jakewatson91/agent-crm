import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { advanceAccounts } from '../inngest/functions/advance_accounts.ts';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'af602fa1-1e0b-4bee-9841-01894553e0a9';

async function main() {
  const w = await sb.from('workspaces').select('policy').eq('id', WS).maybeSingle();
  const enr = (w.data?.policy as any)?.enrichment ?? {};
  const contactCap = enr.max_contact_pulls_per_run ?? 8;
  const draftCap = enr.max_drafts_per_run ?? 12;
  console.log(`advance run · contactCap=${contactCap} draftCap=${draftCap} (from workspace policy)`);
  const a = await advanceAccounts(sb as any, { workspace_id: WS, contactCap, draftCap, onEvent: console.log });
  console.log('\nresult:', JSON.stringify({ scanned: a.scanned, contacts_pulled: a.contacts_pulled, contacts_created: a.contacts_created, drafts_created: a.drafts_created, paused: a.paused ? `${a.paused.scope ?? 'all'}: ${a.paused.reason}` : null }, null, 2));
  console.log('decisions:', JSON.stringify(a.decisions));
}
main().catch((e) => { console.error(e); process.exit(1); });
