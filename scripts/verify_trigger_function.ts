/**
 * Verify the live notify_inngest_signal function body matches migration 0018
 * (vault-backed) rather than the old GUC version.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import pg from 'pg';

async function main() {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error('SUPABASE_DB_URL not set');
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const r = await client.query(`select pg_get_functiondef('notify_inngest_signal'::regproc) as body`);
  const body = r.rows[0]?.body as string | undefined;
  if (!body) throw new Error('function not found');

  const usesVault = body.includes('vault.decrypted_secrets');
  const usesGuc = body.includes('current_setting');
  console.log(`uses vault: ${usesVault}`);
  console.log(`uses GUC:   ${usesGuc}`);
  console.log(usesVault && !usesGuc ? '✓ migration 0018 active' : '✗ trigger not updated yet');

  await client.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
