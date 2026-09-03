import { config } from 'dotenv';
config({ path: '.env.local' });
import pg from 'pg';

/**
 * Return space freed by deleted rows to the OS.
 *
 * Deleting rows does not shrink the file. Supabase's quota reads
 * pg_database_size_bytes, which counts allocated pages, so space that is free
 * inside a table still reads as space used and the meter does not move.
 *
 * Two steps, and only the second one blocks:
 *
 *   reindex  — `reindex table concurrently` rebuilds the indexes under a lock
 *              that still lets reads and writes through. Measured 2026-09-03
 *              after removing 79,100 fact rows and 79,857 events: facts
 *              113MB -> 82MB in 7s, events 228MB -> 197MB in 38s, whole
 *              database 468MB -> 406MB.
 *
 *   vacuum   — `vacuum full` rewrites the heap, which is the only way to give
 *              back the free space inside it (facts measured 40.9% free,
 *              events 23.5%, about 48MB together). It takes an ACCESS
 *              EXCLUSIVE lock: every read and write on the table blocks for
 *              the rewrite, so run it while the pipeline is paused. The online
 *              alternative, pg_repack, is available as an extension on this
 *              project but needs a client binary that is not installed.
 *              lock_timeout makes it give up rather than queue behind a long
 *              transaction while holding everything else behind itself.
 *
 *   npx tsx scripts/_reclaim_disk.ts            # reindex only, no lock
 *   npx tsx scripts/_reclaim_disk.ts --vacuum   # + the blocking rewrite
 */

const TABLES = ['facts', 'events'];
const VACUUM = process.argv.includes('--vacuum');

const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });

async function size(t: string): Promise<string> {
  return (await c.query('select pg_size_pretty(pg_total_relation_size($1::regclass)) s', [t])).rows[0].s;
}

async function main() {
  await c.connect();
  await c.query("set statement_timeout = '0'");
  await c.query("set lock_timeout = '30s'");

  console.log(`db before: ${(await c.query('select pg_size_pretty(pg_database_size(current_database())) t')).rows[0].t}`);

  for (const t of TABLES) {
    const before = await size(t);
    const t0 = Date.now();
    await c.query(`reindex table concurrently ${t}`);
    console.log(`  reindex ${t}: ${before} -> ${await size(t)}  (${((Date.now() - t0) / 1000).toFixed(0)}s, no lock)`);
  }

  if (VACUUM) {
    for (const t of TABLES) {
      const before = await size(t);
      const t0 = Date.now();
      await c.query(`vacuum (full, analyze) ${t}`);
      console.log(`  vacuum full ${t}: ${before} -> ${await size(t)}  (${((Date.now() - t0) / 1000).toFixed(0)}s LOCKED)`);
    }
  } else {
    console.log('  skipped vacuum full (pass --vacuum; it locks the table for the rewrite)');
  }

  console.log(`db after:  ${(await c.query('select pg_size_pretty(pg_database_size(current_database())) t')).rows[0].t}`);
  await c.end();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
