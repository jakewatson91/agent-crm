/**
 * Production setup for Inngest event publishing from Postgres triggers.
 *
 * What this does, in one transaction-safe sequence:
 *   1. Stores the Inngest event ingestion URL in Supabase Vault (idempotent).
 *   2. Applies migration 0018 which rewrites notify_inngest_signal/gate to read
 *      the URL from vault.decrypted_secrets instead of dead Postgres GUCs.
 *
 * After this runs, every signal/gate insert will publish to Inngest atomically
 * (via pg_net inside the AFTER INSERT trigger). The recover-unmatched-signals
 * cron stays as the safety net for any failed publishes.
 *
 * Reads:
 *   - SUPABASE_DB_URL  (must point to prod, NOT 127.0.0.1)
 *   - INNGEST_EVENT_KEY
 *
 * Idempotent. Safe to re-run.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { readFileSync } from 'node:fs';
import pg from 'pg';

const SECRET_NAME = 'inngest_event_url';
const MIGRATION_PATH = 'supabase/migrations/0018_inngest_via_vault.sql';

async function main() {
  const url = process.env.SUPABASE_DB_URL;
  const key = process.env.INNGEST_EVENT_KEY;
  if (!url) throw new Error('SUPABASE_DB_URL not set');
  if (url.includes('127.0.0.1') || url.includes('localhost')) {
    throw new Error('SUPABASE_DB_URL points to local dev. Update .env.local with the prod connection string.');
  }
  if (!key) throw new Error('INNGEST_EVENT_KEY not set');

  const ingestUrl = `https://inn.gs/e/${key}`;

  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log('connected');

  // 1. Upsert Vault secret. vault.create_secret throws if name exists, so check first.
  const existing = await client.query(`select id from vault.secrets where name = $1`, [SECRET_NAME]);
  if (existing.rows.length > 0) {
    await client.query(`select vault.update_secret($1::uuid, $2::text)`, [existing.rows[0].id, ingestUrl]);
    console.log(`✓ vault secret '${SECRET_NAME}' updated`);
  } else {
    await client.query(`select vault.create_secret($1::text, $2::text)`, [ingestUrl, SECRET_NAME]);
    console.log(`✓ vault secret '${SECRET_NAME}' created`);
  }

  // 2. Apply the migration that rewrites the trigger functions.
  const sql = readFileSync(MIGRATION_PATH, 'utf8');
  await client.query(sql);
  console.log(`✓ applied ${MIGRATION_PATH}`);

  // 3. Smoke-test: read the secret back via the same view the trigger uses.
  const verify = await client.query(`select decrypted_secret from vault.decrypted_secrets where name = $1`, [SECRET_NAME]);
  const visible = (verify.rows[0]?.decrypted_secret as string | undefined) ?? '';
  console.log(`✓ trigger will read: ${visible.replace(/(\/e\/)[^\/]+$/, '$1***')}`);

  await client.end();
  console.log('\ndone. next signal/gate insert will publish to Inngest atomically.');
}
main().catch((e) => { console.error(e); process.exit(1); });
