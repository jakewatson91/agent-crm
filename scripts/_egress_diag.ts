import { config } from 'dotenv';
config({ path: '.env.local' });
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  await c.connect();

  // window over which pg_stat_statements has been accumulating
  const reset = await c.query(`select stats_reset from pg_stat_database where datname = current_database()`);
  const start = await c.query(`select pg_postmaster_start_time() as t`);
  console.log('stats_reset:', reset.rows[0]?.stats_reset, ' | pg start:', start.rows[0]?.t);

  // size of the workspace blobs that get read on nearly every op
  console.log('\n=== workspaces blob sizes (bytes) ===');
  const ws = await c.query(`
    select id,
      pg_column_size(policy)   as policy_b,
      pg_column_size(about)    as about_b,
      pg_column_size(persona)  as persona_b,
      pg_column_size(icp)      as icp_b,
      pg_column_size(policy)+coalesce(pg_column_size(about),0)+coalesce(pg_column_size(persona),0)+coalesce(pg_column_size(icp),0) as total_b
    from workspaces order by total_b desc`);
  console.table(ws.rows);

  // estimate per-call payload * calls for the hottest reads, using avg row width.
  // pg_stat_statements has no byte counter, so approximate egress = calls * mean_bytes_of_returned_columns.
  console.log('\n=== hot reads: calls + estimated bytes/call (manual) ===');
  const hot = await c.query(`
    select calls, rows,
      left(regexp_replace(query,'\\s+',' ','g'), 90) as q
    from pg_stat_statements
    where query ilike '%workspaces%policy%' or query ilike '%workspaces%icp%' or query ilike '%role_classifications%'
    order by calls desc limit 12`);
  console.table(hot.rows);

  // biggest tables that could be fetched whole (full-scan egress risk)
  console.log('\n=== table sizes (top 12) ===');
  const t = await c.query(`
    select relname,
      pg_size_pretty(pg_total_relation_size(c.oid)) as total,
      (select reltuples::bigint from pg_class where oid=c.oid) as approx_rows
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r'
    order by pg_total_relation_size(c.oid) desc limit 12`);
  console.table(t.rows);

  // does any column on hot tables carry embeddings / big text returned in selects?
  console.log('\n=== signals/events/facts wide columns ===');
  const w = await c.query(`
    select 'signals' tbl, avg(pg_column_size(s.*))::int avg_row_b, max(pg_column_size(s.*)) max_row_b from signals s
    union all select 'facts', avg(pg_column_size(f.*))::int, max(pg_column_size(f.*)) from facts f
    union all select 'events', avg(pg_column_size(e.*))::int, max(pg_column_size(e.*)) from events e
    union all select 'entities', avg(pg_column_size(en.*))::int, max(pg_column_size(en.*)) from entities en`);
  console.table(w.rows);

  await c.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
