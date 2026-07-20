import { config } from 'dotenv';
config({ path: '.env.local' });
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  await c.connect();
  // top-level keys of policy and their serialized size
  const r = await c.query(`
    select key,
      pg_column_size(value) as size_b,
      left(value::text, 80) as preview
    from workspaces w, jsonb_each(w.policy)
    where w.id = 'af602fa1-1e0b-4bee-9841-01894553e0a9'
    order by pg_column_size(value) desc`);
  console.table(r.rows);

  // if one key is an array/object, drill in
  console.log('\n=== total policy text length ===');
  const t = await c.query(`select length(policy::text) as chars, pg_column_size(policy) as stored_b from workspaces where id='af602fa1-1e0b-4bee-9841-01894553e0a9'`);
  console.log(t.rows[0]);

  await c.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
