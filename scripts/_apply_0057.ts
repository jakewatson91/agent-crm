import { config } from 'dotenv';
config({ path: '.env.local' });
import pg from 'pg';
import { readFileSync } from 'node:fs';
const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
async function main() {
  await c.connect();
  await c.query(readFileSync('supabase/migrations/0057_record_event_argument_id.sql', 'utf8'));
  // Read the deployed body back: the whole point of this migration is a column
  // that was present in the table and absent from the writer, so confirming the
  // file ran is not the same as confirming the writer changed.
  const r = await c.query(`select pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.proname = 'record_event' and n.nspname = 'public'`);
  const def = r.rows[0]?.def ?? '';
  const inInsert = /insert into channel_posts[\s\S]{0,400}?argument_id/.test(def);
  const inValues = def.includes("p_payload->>'argument_id'");
  console.log('argument_id in the channel_posts insert column list:', inInsert);
  console.log("argument_id read from the payload:", inValues);
  console.log('deployed record_event definitions found:', r.rows.length);
  await c.end();
  if (!inInsert || !inValues) process.exit(1);
}
main().catch(e => { console.error(e.message); process.exit(1); });
