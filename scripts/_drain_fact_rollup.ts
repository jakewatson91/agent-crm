import { config } from 'dotenv';
config({ path: '.env.local' });
import pg from 'pg';

/**
 * Drain the fact-history rollup backlog on the direct connection.
 *
 * runRetention calls prune_fact_history over PostgREST, where the
 * authenticator role's 8s statement_timeout applies to every call. A batch of
 * 2,000 fits comfortably once retention is keeping up with a day at a time; a
 * backlog does not, and on 2026-09-03 Sudden's first monthly-grain pass (14,866
 * candidates) was killed mid-batch. This runs the same function with no
 * timeout, in small batches, and prints per-batch timings so the batch constant
 * in retention.ts can be set from a measurement rather than a guess.
 *
 *   npx tsx scripts/_drain_fact_rollup.ts [batch]
 */
const BATCH = Number(process.argv[2] ?? 500);
const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  await c.connect();
  await c.query("set statement_timeout = '600s'");
  const ws = (await c.query(`
    select id, name, policy->'retention' as ret from workspaces
    where coalesce((policy->'retention'->>'fact_history_ttl_days')::int, 0) > 0`)).rows;

  for (const w of ws as Array<{ id: string; name: string; ret: { fact_history_ttl_days: number; prunable_fact_predicates: string[]; fact_history_grain?: string } }>) {
    const preds = w.ret.prunable_fact_predicates ?? [];
    const grain = w.ret.fact_history_grain ?? 'day';
    let total = 0; const times: number[] = [];
    for (;;) {
      const t0 = Date.now();
      const r = await c.query(
        `select prune_fact_history($1, $2, now() - ($3||' days')::interval, $4, $5) as n`,
        [w.id, preds, String(w.ret.fact_history_ttl_days), BATCH, grain]);
      const ms = Date.now() - t0;
      const n = Number(r.rows[0].n);
      total += n; times.push(ms);
      process.stdout.write(`\r  ${w.name}: ${total} facts (last batch ${n} in ${ms}ms)          `);
      if (n < BATCH) break;
    }
    const worst = Math.max(...times, 0);
    console.log(`\n  ${w.name}: ${total} facts, ${times.length} batches of ${BATCH}, slowest ${worst}ms`);

    // The events those facts were the last reference to.
    const actions = (await c.query(`select policy->'retention'->'prunable_event_actions' as a from workspaces where id=$1`, [w.id])).rows[0].a ?? [];
    let ev = 0; const evTimes: number[] = [];
    for (;;) {
      const t0 = Date.now();
      const r = await c.query(
        `select prune_events($1, $2, now() - ($3||' days')::interval, $4) as n`,
        [w.id, actions, String(w.ret.fact_history_ttl_days), BATCH]);
      const ms = Date.now() - t0;
      const n = Number(r.rows[0].n);
      ev += n; evTimes.push(ms);
      process.stdout.write(`\r  ${w.name}: ${ev} events (last batch ${n} in ${ms}ms)          `);
      if (n < BATCH) break;
    }
    console.log(`\n  ${w.name}: ${ev} events, ${evTimes.length} batches of ${BATCH}, slowest ${Math.max(...evTimes, 0)}ms`);
  }
  await c.end();
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
