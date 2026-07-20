import { config } from 'dotenv';
config({ path: '.env.local' });
import { findContactsExplorium } from '@agent-crm/tools';
async function main() {
  const key = process.env.EXPLORIUM_API_KEY;
  console.log('key present:', !!key, key ? `(len ${key.length})` : '');
  const domain = process.argv[2] || 'earthapro.com';
  console.log('domain:', domain);
  const t = Date.now();
  const out = await findContactsExplorium({ domain, apiKey: key!, limit: 3, role_filter: 'founder' });
  console.log(`\n${out.length} contact(s) in ${Date.now()-t}ms:`);
  for (const c of out) console.log(`  - ${c.name} <${c.email}> — ${c.role}`);
}
main().catch((e)=>{console.error('ERR:', e.message);});
