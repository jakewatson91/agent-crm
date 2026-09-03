import { config } from 'dotenv';
config({ path: '.env.local' });
import pg from 'pg';

/**
 * Set policy.retention.fact_history_grain on every workspace that has the fact
 * rollup switched on. 'month' instead of the 'day' default (migration 0060):
 * scoring runs about once a day per account, so a daily grain has almost no
 * intra-period re-reads to collapse and the rollup deletes nothing.
 *
 *   npx tsx scripts/_cfg_fact_history_grain.ts month
 */
const grain = process.argv[2] ?? 'month';
if (!['day', 'month'].includes(grain)) { console.error(`grain must be day or month, got ${grain}`); process.exit(1); }

const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
async function main() {
  await c.connect();
  const r = await c.query(`
    update workspaces
       set policy = jsonb_set(policy, '{retention,fact_history_grain}', to_jsonb($1::text), true)
     where coalesce((policy->'retention'->>'fact_history_ttl_days')::int, 0) > 0
       and jsonb_array_length(coalesce(policy->'retention'->'prunable_fact_predicates', '[]'::jsonb)) > 0
    returning name, policy->'retention'->>'fact_history_grain' as grain,
              policy->'retention'->>'fact_history_ttl_days' as ttl_days`, [grain]);
  r.rows.forEach((x) => console.log(`  ${x.name}: grain=${x.grain} ttl=${x.ttl_days}d`));
  if (r.rowCount === 0) console.log('  no workspace has the fact rollup on');
  await c.end();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
