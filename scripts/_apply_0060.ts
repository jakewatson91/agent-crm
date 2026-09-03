import { config } from 'dotenv';
config({ path: '.env.local' });
import pg from 'pg';
import { readFileSync } from 'node:fs';
const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
async function main() {
  await c.connect();
  await c.query(readFileSync('supabase/migrations/0060_fact_history_grain.sql', 'utf8'));
  const sigs = await c.query(`
    select pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where p.proname = 'prune_fact_history' and ns.nspname = 'public'`);
  console.log('prune_fact_history overloads:');
  sigs.rows.forEach((r) => console.log('  ', r.args));

  // A 4-arg call has to still resolve (retention.ts callers, and the 5-arg
  // default is what makes that unambiguous), and an unlisted grain has to be
  // refused rather than passed to date_trunc.
  await c.query('begin');
  const four = await c.query(`select prune_fact_history($1::uuid, $2::text[], now() - interval '999 years', 1) as n`,
    ['00000000-0000-0000-0000-000000000000', ['score_total']]);
  console.log('4-arg call resolves:', four.rows[0].n === 0);
  let refused = false;
  try { await c.query(`select prune_fact_history($1::uuid, $2::text[], now(), 1, 'year')`, ['00000000-0000-0000-0000-000000000000', ['score_total']]); }
  catch { refused = true; }
  await c.query('rollback');
  console.log('grain "year" refused:', refused);
  await c.end();
  if (sigs.rows.length !== 1 || four.rows[0].n !== 0 || !refused) process.exit(1);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
