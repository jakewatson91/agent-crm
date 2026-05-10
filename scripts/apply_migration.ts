/**
 * Apply a single migration file to the Supabase Postgres instance via direct pg connection.
 * Idempotent only if the migration uses CREATE OR REPLACE / IF NOT EXISTS.
 *
 * Usage: pnpm exec tsx scripts/apply_migration.ts supabase/migrations/0016_find_similar_entities.sql
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { readFileSync } from 'node:fs';
import pg from 'pg';

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('usage: apply_migration.ts <path-to-sql>');

  const sql = readFileSync(file, 'utf8');
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error('SUPABASE_DB_URL not set');

  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log(`applying ${file} (${sql.length} chars)...`);
  await client.query(sql);
  console.log('✓ applied');
  await client.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
