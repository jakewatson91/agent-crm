import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { backfillAccountDomainsFromContactEmails } from '@agent-crm/tools';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
async function main() {
  const apply = process.argv.includes('--apply');
  const r = await backfillAccountDomainsFromContactEmails(sb, { workspace_id: WS, apply });
  console.log(`mode: ${apply ? 'APPLY' : 'dry-run'}`);
  console.log(`accounts with contact email: ${r.accounts_with_contact_email}`);
  console.log(`domains ${apply ? 'set' : 'would set'}: ${r.domains_set}  (skipped: has_domain=${r.skipped_has_domain}, conflict=${r.skipped_conflict})`);
  for (const s of r.set) console.log(`  ${s.name} → ${s.domain}`);
  console.log(`name-mismatch skips (${r.skipped_name_mismatch.length}):`);
  for (const s of r.skipped_name_mismatch) console.log(`  SKIP ${s.name} ✗ ${s.domain}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
// (mismatches printed by rerun below)
