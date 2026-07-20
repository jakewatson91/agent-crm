import { config } from 'dotenv';
config({ path: '.env.local' });
import pg from 'pg';
import { readFileSync } from 'node:fs';
const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
async function main() {
  await c.connect();
  const sql = readFileSync('supabase/migrations/0045_events_parent_index.sql', 'utf8');
  await c.query(sql);
  const r = await c.query(`select indexname from pg_indexes where tablename = 'events' and indexname = 'events_parent_event_idx'`);
  console.log('index created:', r.rows.length > 0);
  await c.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
