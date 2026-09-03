import { config } from 'dotenv';
config({ path: '.env.local' });
import pg from 'pg';

/**
 * Switch on the usage meter that shipped in 7fd71bc.
 *
 * `usage.ts` reads egress per cycle and database size off the project's
 * Prometheus endpoint, because neither is visible from inside Postgres. It does
 * nothing at all unless `policy.limits` is set, on purpose: the caps belong to
 * whatever plan the customer is on and guessing them is worse than not
 * enforcing them. Nobody had set them, so as of 2026-09-03 there were zero
 * `usage_sample` events and the meter had never taken a reading.
 *
 * Written to one workspace, not all of them. The meters are per PROJECT, not
 * per workspace: every workspace on this database shares one egress budget and
 * one disk. Sampling from four workspaces would count the same bytes four times
 * and quadruple the reported total.
 *
 *   npx tsx scripts/_cfg_usage_limits.ts <workspace-id-prefix> <egress_gb> <db_mb> [cycle_day]
 *   npx tsx scripts/_cfg_usage_limits.ts e7052848 5 500
 */
const [prefix, egress, db, cycleDay] = process.argv.slice(2);
if (!prefix || !egress || !db) {
  console.error('usage: _cfg_usage_limits.ts <workspace-id-prefix> <egress_gb> <db_mb> [cycle_day]');
  process.exit(1);
}
const limits: Record<string, number> = { egress_gb: Number(egress), db_mb: Number(db) };
if (cycleDay) limits.cycle_day = Number(cycleDay);

const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
async function main() {
  await c.connect();
  const other = await c.query(
    `select name from workspaces where policy ? 'limits' and id::text not like $1 || '%'`, [prefix]);
  if (other.rowCount) {
    console.error(`refusing: ${other.rows.map((r) => r.name).join(', ')} already carries limits, and the meters are per project. Clear those first.`);
    await c.end();
    process.exit(1);
  }
  const r = await c.query(
    `update workspaces set policy = jsonb_set(policy, '{limits}', $2::jsonb, true)
      where id::text like $1 || '%' returning name, policy->'limits' as limits`, [prefix, JSON.stringify(limits)]);
  if (!r.rowCount) { console.error(`no workspace matches ${prefix}`); await c.end(); process.exit(1); }
  r.rows.forEach((x) => console.log(`  ${x.name}: ${JSON.stringify(x.limits)}`));
  await c.end();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
