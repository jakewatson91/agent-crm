import { config } from 'dotenv';
config({ path: '.env.local' });
import { findContacts } from '@agent-crm/tools';
async function main() {
  const domain = process.argv[2] ?? 'aquavoice.com';
  console.log(`UNFILTERED probe: ${domain} (1 credit)`);
  const contacts = await findContacts({ domain, limit: 5 }); // no role_filter
  console.log(`returned ${contacts.length}:`);
  for (const c of contacts) console.log(`  ${c.name.padEnd(24).slice(0,24)} ${c.email.padEnd(34)} ${(c.role||'(no role)').slice(0,30)} conf=${c.source_confidence.toFixed(2)}`);
}
main().catch((e) => { console.error('✗', e instanceof Error ? e.message : e); process.exit(1); });
