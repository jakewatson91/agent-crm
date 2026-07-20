import { config } from 'dotenv';
config({ path: '.env.local' });
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  await c.connect();

  console.log('=== per-day growth: signals / create_signal events / facts (last 14d) ===');
  const g = await c.query(`
    with d as (select generate_series(0,13) i)
    select (now()::date - i) as day,
      (select count(*) from signals s where s.created_at::date = (now()::date - i)) as new_signals,
      (select count(*) from events e where e.action='create_signal' and e.created_at::date = (now()::date - i)) as create_signal_ev,
      (select count(*) from events e where e.action in ('assert_fact','supersede_fact') and e.created_at::date = (now()::date - i)) as fact_ev,
      (select count(*) from events e where e.created_at::date = (now()::date - i)) as all_events
    from d order by day desc`);
  console.table(g.rows);

  console.log('\n=== marginal DB cost per signal (current table totals / row counts) ===');
  const m = await c.query(`
    select
      (select pg_total_relation_size('signals'))::bigint as signals_bytes,
      (select count(*) from signals)::bigint as signals_n,
      (select pg_total_relation_size('events'))::bigint as events_bytes,
      (select count(*) from events)::bigint as events_n`);
  const r = m.rows[0];
  console.log(`signals: ${(r.signals_bytes/1e6).toFixed(0)}MB / ${r.signals_n} rows = ${(r.signals_bytes/r.signals_n/1024).toFixed(1)} KB/signal (all-in: heap+index+toast)`);
  console.log(`events : ${(r.events_bytes/1e6).toFixed(0)}MB / ${r.events_n} rows = ${(r.events_bytes/r.events_n/1024).toFixed(1)} KB/event`);

  console.log('\n=== workspace age (oldest signal) ===');
  const a = await c.query(`select min(created_at) oldest, max(created_at) newest, count(*) n from signals`);
  console.log(a.rows[0]);

  await c.end();
}
main().catch(e => { console.error(e); process.exit(1); });
