import { config } from 'dotenv';
config({ path: '.env.local' });
import pg from 'pg';
import { readFileSync } from 'node:fs';
const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
async function main() {
  await c.connect();
  const sql = readFileSync('supabase/migrations/0044_move_embedding_cache_off_policy.sql', 'utf8');
  await c.query(sql);
  const r = await c.query(`select id,
    pg_column_size(policy) as policy_b,
    pg_column_size(embedding_cache) as cache_b,
    (policy ? 'icp_embedding_cache') as still_in_policy
    from workspaces`);
  console.table(r.rows);
  await c.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
