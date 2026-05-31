/**
 * Apply every supabase/migrations/*.sql file in order against SUPABASE_DB_URL.
 *
 * Used by `pnpm self-host:migrate` after the local Supabase stack is up
 * (see self-host/supabase/bootstrap.sh). Safe to re-run: each migration is
 * wrapped in a transaction and we record applied filenames in a
 * meta._migrations table so completed migrations are skipped.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const MIGRATIONS_DIR = 'supabase/migrations';

async function main() {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error('SUPABASE_DB_URL not set in .env.local (e.g. postgresql://postgres:<pw>@localhost:5432/postgres)');

  // Hard guard: this script is for the self-host local stack. Running it
  // against a hosted Supabase would re-apply old migrations and corrupt
  // history. Force the user to set ALLOW_REMOTE_MIGRATE=1 if they really
  // want to bootstrap a fresh remote project (rare).
  const isLocal = /\/\/[^@]*@(localhost|127\.0\.0\.1|host\.docker\.internal)/.test(url);
  if (!isLocal && process.env.ALLOW_REMOTE_MIGRATE !== '1') {
    throw new Error(
      `SUPABASE_DB_URL does not look local (${url.replace(/:[^:@]+@/, ':***@')}). ` +
      `Refusing to run. Set ALLOW_REMOTE_MIGRATE=1 if you actually want to bootstrap a remote DB.`,
    );
  }

  const client = new pg.Client({
    connectionString: url,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });
  await client.connect();

  await client.query(`
    create schema if not exists meta;
    create table if not exists meta._migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    );
  `);

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  console.log(`[migrate] found ${files.length} migration files in ${MIGRATIONS_DIR}`);

  const applied = new Set(
    (await client.query<{ filename: string }>('select filename from meta._migrations')).rows.map((r) => r.filename),
  );

  let appliedCount = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  ⤼ skip ${file} (already applied)`);
      continue;
    }
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    console.log(`  ▶ apply ${file} (${sql.length} chars)`);
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into meta._migrations (filename) values ($1)', [file]);
      await client.query('commit');
      appliedCount++;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ FAILED on ${file}: ${msg}`);
      console.error('  (rolled back; fix the migration or pre-state and re-run)');
      process.exit(1);
    }
  }

  console.log(`[migrate] done. ${appliedCount} newly applied, ${files.length - appliedCount} already in place.`);
  await client.end();
}

main().catch((e: unknown) => {
  console.error('[migrate] fatal:', e instanceof Error ? e.message : e);
  process.exit(1);
});
