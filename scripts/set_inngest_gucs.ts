/**
 * Set the Postgres GUCs the notify_inngest_signal/gate triggers depend on.
 * Reads INNGEST_EVENT_KEY from .env.local; does not put secrets in git.
 *
 * One-time setup. Re-run if the event key rotates.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import pg from 'pg';

async function main() {
  const url = process.env.SUPABASE_DB_URL;
  const key = process.env.INNGEST_EVENT_KEY;
  if (!url) throw new Error('SUPABASE_DB_URL not set (must point to prod, not localhost)');
  if (url.includes('127.0.0.1') || url.includes('localhost')) {
    throw new Error('SUPABASE_DB_URL points to local dev. Update .env.local with the prod connection string from app.supabase.com → Project Settings → Database.');
  }
  if (!key) throw new Error('INNGEST_EVENT_KEY not set');

  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log('connected');

  // Inngest event ingestion URL pattern: https://inn.gs/e/<event_key>
  const endpoint = `https://inn.gs/e/${key}`;

  await client.query(`alter database postgres set app.inngest_endpoint = $1`.replace('$1', `'${endpoint}'`));
  await client.query(`alter database postgres set app.inngest_event_key = $1`.replace('$1', `'${key}'`));
  console.log('✓ alter database settings applied');

  // Verify by reading back via current_setting (only works in same session if SET LOCAL,
  // but ALTER DATABASE applies to NEW sessions, so reconnect):
  await client.end();
  const c2 = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c2.connect();
  const r = await c2.query(`select current_setting('app.inngest_endpoint', true) as endpoint`);
  console.log(`endpoint visible to new session: ${r.rows[0]?.endpoint?.slice(0, 40) ?? '(unset)'}…`);
  await c2.end();
  console.log('done. next signal insert will trigger Inngest fan-out.');
}
main().catch((e) => { console.error(e); process.exit(1); });
