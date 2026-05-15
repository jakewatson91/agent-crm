/**
 * Poll until all active Exa sources have a last_run_at within the last 5 min,
 * or until ~3 minutes elapse. Exits 0 on success, 1 on timeout.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const startedAt = Date.now();
  const deadline = startedAt + 180_000;
  while (Date.now() < deadline) {
    const r = await sb.from('sources')
      .select('name, last_run_at, last_run_status')
      .eq('connector_type', 'exa').eq('active', true);
    const rows = (r.data ?? []) as Array<{ name: string; last_run_at: string | null; last_run_status: string | null }>;
    const cutoff = new Date(startedAt - 30_000).toISOString();
    const fresh = rows.filter((s) => s.last_run_at && s.last_run_at >= cutoff);
    const okCount = fresh.filter((s) => s.last_run_status === 'ok').length;
    const errCount = fresh.filter((s) => s.last_run_status === 'error').length;
    console.log(`[${new Date().toISOString().slice(11, 19)}] exa fresh=${fresh.length}/${rows.length} ok=${okCount} err=${errCount}`);
    if (fresh.length === rows.length) {
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  console.log('timeout');
  process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
