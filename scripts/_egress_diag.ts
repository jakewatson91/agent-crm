import { config } from 'dotenv';
config({ path: '.env.local' });
import pg from 'pg';

/**
 * Where Supabase egress is going.
 *
 * Two things this has to get right, both of which sent the 2026-09-01
 * investigation down a wrong path first:
 *
 * 1. pg_stat_statements has no byte counter, and pg_stats.avg_width reports the
 *    TOAST pointer for a large jsonb column rather than its contents —
 *    workspaces.policy measured 52 bytes that way when it is 16,608 bytes on
 *    the wire. So column widths here come from pg_column_size on live rows, and
 *    even that is the COMPRESSED size: the wire format is uncompressed JSON,
 *    measured at ~1.75x for this table's jsonb.
 * 2. pg_stat_statements is cumulative since the last reset (81 days as of
 *    2026-09-01). A fix that shipped last week is invisible in those totals.
 *    Pass a minute count to get the CURRENT per-statement rate instead.
 *
 * The one real byte counter is node_network_transmit_bytes_total on the
 * project's Prometheus endpoint. It covers everything leaving the instance,
 * including Supabase's own log shipping, so it runs above the billed number —
 * treat it as the ceiling and the shape, not the invoice.
 *
 *   npx tsx scripts/_egress_diag.ts        # cumulative breakdown
 *   npx tsx scripts/_egress_diag.ts 10     # + live rate over 10 minutes
 */

const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
const JSON_INFLATION = 1.75;

async function transmitted(): Promise<number> {
  const ref = String(process.env.NEXT_PUBLIC_SUPABASE_URL).replace(/^https:\/\/([^.]+)\..*$/, '$1');
  const auth = Buffer.from(`service_role:${process.env.SUPABASE_SERVICE_ROLE_KEY}`).toString('base64');
  const t = await (await fetch(`https://${ref}.supabase.co/customer/v1/privileged/metrics`, { headers: { authorization: `Basic ${auth}` } })).text();
  const l = t.split('\n').find((x) => x.startsWith('node_network_transmit_bytes_total') && x.includes('ens5'));
  return l ? Number(l.slice(l.lastIndexOf(' ') + 1)) : NaN;
}

/** Real detoasted average width per column, which pg_stats cannot give us. */
async function columnWidths(tables: string[]): Promise<Map<string, number>> {
  const widths = new Map<string, number>();
  for (const t of tables) {
    const cols = (await c.query(
      `select column_name from information_schema.columns where table_schema='public' and table_name=$1`, [t],
    )).rows.map((r: { column_name: string }) => r.column_name);
    if (!cols.length) continue;
    const sel = cols.map((k) => `avg(pg_column_size("${k}"))::numeric as "${k}"`).join(', ');
    const row = (await c.query(`select ${sel} from (select * from "${t}" limit 3000) s`)).rows[0];
    for (const k of cols) widths.set(`${t}.${k}`, Math.round(Number(row[k] ?? 20)));
  }
  return widths;
}

async function snapshot(): Promise<Map<string, { calls: number; rows: number; query: string }>> {
  const m = new Map<string, { calls: number; rows: number; query: string }>();
  for (const r of (await c.query(`select queryid, calls, rows, query from pg_stat_statements where calls > 0`)).rows) {
    m.set(String(r.queryid), { calls: Number(r.calls), rows: Number(r.rows), query: String(r.query) });
  }
  return m;
}

/** "table.column" pairs a PostgREST statement selects, in wire-byte terms. */
function rowBytes(query: string, widths: Map<string, number>): { bytes: number; table: string } | null {
  const uniq = [...new Set([...query.matchAll(/"public"\."(\w+)"\."(\w+)"/g)].map((m) => `${m[1]}.${m[2]}`))];
  if (!uniq.length) return null;
  // value bytes + the json key name, quotes and comma PostgREST wraps it in
  const raw = uniq.reduce((a, k) => a + (widths.get(k) ?? 20) + k.split('.')[1].length + 4, 2);
  return { bytes: Math.round(raw * JSON_INFLATION), table: uniq[0].split('.')[0] };
}

async function main() {
  await c.connect();
  const watchMin = Number(process.argv[2] ?? 0);

  const reset = (await c.query(`select stats_reset from pg_stat_statements_info`)).rows[0]?.stats_reset as Date | undefined;
  const days = reset ? (Date.now() - reset.getTime()) / 86_400_000 : 81;
  console.log(`pg_stat_statements since ${reset?.toISOString() ?? 'unknown'} (${days.toFixed(0)} days)`);

  const tx = await transmitted();
  if (Number.isFinite(tx)) {
    console.log(`network transmit: ${(tx / 1e9).toFixed(2)} GB total => ${(tx / days / 1e6).toFixed(0)} MB/day average (all traffic off the instance, Supabase's own log shipping included)`);
  }

  console.log('\n=== workspace config blobs: what a single read of this row costs ===');
  const ws = await c.query(`
    select id, pg_column_size(policy) policy_b, pg_column_size(about) about_b,
      pg_column_size(persona) persona_b, pg_column_size(icp) icp_b, pg_column_size(embedding_cache) cache_b
    from workspaces order by policy_b desc nulls last`);
  console.table(ws.rows.map((r: Record<string, number | string>) => ({
    ws: String(r.id).slice(0, 8),
    policy_wire_b: Math.round(Number(r.policy_b) * JSON_INFLATION),
    about_b: r.about_b, persona_b: r.persona_b, icp_b: r.icp_b, embedding_cache_b: r.cache_b,
  })));

  console.log('\n=== biggest policy sections (a caller wanting one of these ships all of them) ===');
  const sec = await c.query(`
    select w.id, k.key, pg_column_size(w.policy->k.key) as bytes
    from workspaces w, lateral jsonb_object_keys(w.policy) k(key)
    where pg_column_size(w.policy->k.key) > 500 order by bytes desc limit 12`);
  console.table(sec.rows.map((r: Record<string, number | string>) => ({ ws: String(r.id).slice(0, 8), section: r.key, bytes: r.bytes })));

  const widths = await columnWidths(['workspaces', 'entities', 'facts', 'signals', 'events', 'role_classifications', 'subscriptions', 'channels', 'channel_posts', 'gates']);

  console.log('\n=== cumulative: response bodies by statement ===');
  const st = await snapshot();
  const out: Array<Record<string, unknown>> = [];
  let total = 0;
  for (const s of st.values()) {
    if (s.rows <= 0) continue;
    const rb = rowBytes(s.query, widths);
    if (!rb) continue;
    const bytes = rb.bytes * s.rows;
    total += bytes;
    out.push({ mb_day: +(bytes / days / 1e6).toFixed(1), calls: s.calls, per_row_b: rb.bytes, t: rb.table, q: s.query.replace(/\s+/g, ' ').slice(0, 58) });
  }
  out.sort((a, b) => Number(b.mb_day) - Number(a.mb_day));
  console.table(out.slice(0, 12));
  console.log(`response bodies: ${(total / days / 1e6).toFixed(0)} MB/day` +
    (Number.isFinite(tx) ? `, which is ${((total / tx) * 100).toFixed(0)}% of transmit — the rest is per-request overhead, so request COUNT is the lever, not payload size` : ''));

  if (watchMin > 0) {
    console.log(`\n=== live rate: sampling ${watchMin} min (cumulative totals cannot show whether a recent fix worked) ===`);
    const before = await snapshot();
    const txBefore = await transmitted();
    await new Promise((r) => setTimeout(r, watchMin * 60_000));
    const after = await snapshot();
    const txAfter = await transmitted();
    const hours = watchMin / 60;
    const live: Array<Record<string, unknown>> = [];
    let calls = 0;
    for (const [id, cur] of after) {
      const dc = cur.calls - (before.get(id)?.calls ?? 0);
      if (dc <= 0) continue;
      calls += dc;
      const rb = rowBytes(cur.query, widths);
      live.push({ calls_day: Math.round(dc / hours * 24), mb_day: rb ? +((rb.bytes * (cur.rows - (before.get(id)?.rows ?? 0))) / hours * 24 / 1e6).toFixed(2) : 0, q: cur.query.replace(/\s+/g, ' ').slice(0, 72) });
    }
    live.sort((a, b) => Number(b.calls_day) - Number(a.calls_day));
    console.table(live.slice(0, 15));
    console.log(`${Math.round(calls / hours * 24).toLocaleString()} statements/day` +
      (Number.isFinite(txAfter) && txAfter > txBefore ? `  |  transmit ${((txAfter - txBefore) / hours * 24 / 1e6).toFixed(0)} MB/day` : ''));
  }

  await c.end();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
