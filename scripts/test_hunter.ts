/**
 * One-shot test: call findContacts on a known domain to verify Hunter integration.
 * Doesn't write anything; just hits the API and prints.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { findContacts } from '@agent-crm/tools';

async function main() {
  if (!process.env.HUNTER_API_KEY) throw new Error('HUNTER_API_KEY not set');
  const domain = process.argv[2] ?? 'stripe.com';
  console.log(`looking up contacts for ${domain}...`);
  const contacts = await findContacts({ domain, limit: 5 });
  console.log(`✓ ${contacts.length} contacts:`);
  for (const c of contacts) {
    console.log(`  ${c.name.padEnd(28)} ${c.email.padEnd(35)} ${c.role || '(no role)'} (conf=${c.source_confidence.toFixed(2)})`);
  }
}
main().catch((e) => { console.error('✗', e.message); process.exit(1); });
