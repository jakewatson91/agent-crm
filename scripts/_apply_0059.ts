import { config } from 'dotenv';
config({ path: '.env.local' });
import pg from 'pg';
import { readFileSync } from 'node:fs';
const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
async function main() {
  await c.connect();
  await c.query(readFileSync('supabase/migrations/0059_score_inputs.sql', 'utf8'));
  const r = await c.query(`select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace where p.proname = 'score_inputs' and ns.nspname = 'public'`);
  const i = await c.query(`select indexdef from pg_indexes where indexname = 'facts_ws_supersedes_idx'`);
  console.log('score_inputs deployed:', r.rows[0].n === 1);
  console.log('index:', i.rows[0]?.indexdef ?? 'MISSING');
  await c.end();
  if (r.rows[0].n !== 1 || !i.rows[0]) process.exit(1);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
